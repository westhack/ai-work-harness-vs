/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { AgentEvent } from "../types";
import { buildPromptWithHistory } from "./dispatch";
import type { AgentEngine, EngineId, EngineRuntime } from "./types";
import { cachedAvailability, killProcessTree, resolveEngineBinary, spawnCommand } from "./registry";

/** One permission option offered by an agent's session/request_permission call. */
export interface AcpPermissionOption {
	optionId?: unknown;
	kind?: unknown;
}

/**
 * One decoded outcome per JSON-RPC message. Emissions map onto AgentEvent;
 * responses to agent→client requests are built by the run loop with the pure
 * helpers below, keeping the connection testable without spawning a CLI.
 */
export type AcpAction =
	| { kind: "emit"; event: AgentEvent }
	| { kind: "session"; sessionId: string }
	| { kind: "response"; id: string | number; result?: unknown; error?: any }
	| { kind: "auth-required"; instructions: string }
	| { kind: "prompt-result"; stopReason: string }
	| { kind: "rpc-error"; requestId: string | number; message: string }
	| { kind: "permission"; requestId: string | number; toolName: string; input: unknown; callId?: string; options: AcpPermissionOption[] }
	| { kind: "read-file"; requestId: string | number; path: string }
	| { kind: "write-file"; requestId: string | number; path: string; content: string }
	| { kind: "respond"; message: unknown };

/** Liberal text extraction: content may be a string, one block or a block array. */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((block) => {
			const item = block as { type?: string; text?: string };
			return item?.type === "text" && typeof item.text === "string" ? item.text : "";
		}).filter(Boolean).join("");
	}
	const item = content as { type?: string; text?: string } | null;
	return item?.type === "text" && typeof item.text === "string" ? item.text : "";
}

function stringifyValue(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((block) => stringifyValue(block)).filter(Boolean).join("\n");
	return JSON.stringify(value);
}

/** True when `target` resolves inside `root` (case-insensitive on Windows). */
export function isInsideWorkspace(root: string, target: string): boolean {
	if (!root || !target) return false;
	const resolvedRoot = resolve(root);
	const resolvedTarget = resolve(root, target);
	if (resolvedTarget === resolvedRoot) return true;
	const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
	if (process.platform === "win32") return resolvedTarget.toLowerCase().startsWith(rootWithSep.toLowerCase());
	return resolvedTarget.startsWith(rootWithSep);
}

/** Approved → the first allow_* option; denied → the first reject_* option. */
export function permissionResponse(requestId: string | number, options: AcpPermissionOption[], approved: boolean): unknown {
	const list = Array.isArray(options) ? options : [];
	const wanted = approved ? "allow" : "reject";
	const match = list.find((option) => typeof option?.kind === "string" && String(option.kind).startsWith(wanted));
	const chosen = match ?? list[0];
	return {
		jsonrpc: "2.0",
		id: requestId,
		result: { outcome: { outcome: "selected", optionId: chosen?.optionId } },
	};
}

export function acpResultResponse(requestId: string | number, result: unknown): unknown {
	return { jsonrpc: "2.0", id: requestId, result };
}

export function acpErrorResponse(requestId: string | number, message: string): unknown {
	return { jsonrpc: "2.0", id: requestId, error: { code: -32603, message } };
}

/**
 * Stateful JSON-RPC parser for the Agent Client Protocol (stdio, newline
 * delimited). Pure with respect to I/O — every outcome is returned as actions
 * so tests can feed recorded messages without spawning the CLI.
 */
export class AcpConnection {
	private nextIdValue = 1;
	private initializeId: string | number | undefined;
	private sessionNewId: string | number | undefined;
	private promptId: string | number | undefined;
	private toolNames = new Map<string, string>();

	constructor(private readonly cli: string) {}

	initializeMessage() {
		this.initializeId = this.nextIdValue++;
		return {
			jsonrpc: "2.0" as const, id: this.initializeId, method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } },
		};
	}

	newSessionMessage(cwd: string) {
		this.sessionNewId = this.nextIdValue++;
		return { jsonrpc: "2.0" as const, id: this.sessionNewId, method: "session/new", params: { cwd, mcpServers: [] } };
	}

	promptMessage(sessionId: string, text: string) {
		this.promptId = this.nextIdValue++;
		return { jsonrpc: "2.0" as const, id: this.promptId, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text }] } };
	}

	cancelNotification(sessionId: string) {
		return { jsonrpc: "2.0" as const, method: "session/cancel", params: { sessionId } };
	}

	handle(line: string): AcpAction[] {
		const trimmed = line.trim();
		if (!trimmed) return [];
		let msg: any;
		try { msg = JSON.parse(trimmed); } catch { return []; }
		return this.handleMessage(msg);
	}

	handleMessage(msg: any): AcpAction[] {
		if (!msg || typeof msg !== "object") return [];
		if (msg.method !== undefined && msg.id !== undefined) return this.handleAgentRequest(msg);
		if (msg.method !== undefined) return this.handleNotification(msg);
		return this.handleResponseMessage(msg);
	}

	/** Requests the agent sends us; each one must be answered or it hangs. */
	private handleAgentRequest(msg: any): AcpAction[] {
		switch (msg.method) {
			case "session/request_permission": {
				const params = msg.params ?? {};
				const call = params.toolCall ?? {};
				return [{
					kind: "permission",
					requestId: msg.id,
					toolName: String(call.title ?? call.kind ?? "tool"),
					input: params.input ?? call.rawInput ?? {},
					callId: call.toolCallId !== undefined && call.toolCallId !== null ? String(call.toolCallId) : undefined,
					options: Array.isArray(params.options) ? params.options : [],
				}];
			}
			case "fs/read_text_file":
				return [{ kind: "read-file", requestId: msg.id, path: String(msg.params?.path ?? "") }];
			case "fs/write_text_file":
				return [{ kind: "write-file", requestId: msg.id, path: String(msg.params?.path ?? ""), content: String(msg.params?.content ?? "") }];
			default:
				return [{ kind: "respond", message: acpErrorResponse(msg.id, `ACP method not supported by AiWorkHarness: ${String(msg.method)}`) }];
		}
	}

	private handleNotification(msg: any): AcpAction[] {
		if (msg.method !== "session/update") return [];
		const update = msg.params?.update ?? {};
		switch (update.sessionUpdate) {
			case "agent_message_chunk": {
				const text = extractText(update.content);
				return text ? [{ kind: "emit", event: { type: "text-delta", text } }] : [];
			}
			case "agent_thought_chunk": {
				const text = extractText(update.content);
				return text ? [{ kind: "emit", event: { type: "thinking-delta", text } }] : [];
			}
			case "tool_call": {
				const callId = String(update.toolCallId ?? "");
				const name = String(update.title ?? update.kind ?? "tool");
				if (callId) this.toolNames.set(callId, name);
				return [{ kind: "emit", event: {
					type: "tool-call-started",
					callId,
					name,
					input: update.rawInput ?? update.fields ?? {},
				} }];
			}
			case "tool_call_update": {
				const callId = String(update.toolCallId ?? "");
				if (update.status !== "completed" && update.status !== "failed") return [];
				return [{ kind: "emit", event: {
					type: "tool-call-completed",
					callId,
					name: this.toolNames.get(callId) ?? callId,
					status: update.status === "failed" ? "error" : "completed",
					result: stringifyValue(update.rawOutput ?? update.content ?? ""),
				} }];
			}
			default:
				return []; // plan and other session updates are host-internal
		}
	}

	private handleResponseMessage(msg: any): AcpAction[] {
		if (this.promptId !== undefined && msg.id === this.promptId) {
			this.promptId = undefined;
			if (msg.error) return [{ kind: "rpc-error", requestId: msg.id, message: String(msg.error?.message ?? "session/prompt failed") }];
			return [{ kind: "prompt-result", stopReason: String(msg.result?.stopReason ?? "") }];
		}
		const actions: AcpAction[] = [];
		if (this.sessionNewId !== undefined && msg.id === this.sessionNewId && typeof msg.result?.sessionId === "string" && msg.result.sessionId) {
			actions.push({ kind: "session", sessionId: msg.result.sessionId });
		}
		if (this.initializeId !== undefined && msg.id === this.initializeId && msg.result?.authMethod && !msg.error) {
			actions.push({ kind: "auth-required", instructions: `run \`${this.cli} login\` first` });
		}
		actions.push({ kind: "response", id: msg.id, result: msg.result, error: msg.error });
		return actions;
	}
}

export interface AcpDeps {
	spawn: (binary: string, args: string[], cwd: string) => ChildProcess;
	resolveBinary: () => Promise<string | undefined>;
	killTree: (pid: number | undefined) => void;
	readTextFile: (path: string) => Promise<string>;
	writeTextFile: (path: string, content: string) => Promise<void>;
}

function defaultDeps(id: EngineId): AcpDeps {
	return {
		spawn: (binary, args, cwd) => spawnCommand(binary, args, { cwd }),
		resolveBinary: () => resolveEngineBinary(id),
		killTree: killProcessTree,
		readTextFile: (path) => readFile(path, "utf8"),
		writeTextFile: (path, content) => writeFile(path, content, "utf8"),
	};
}

/**
 * Drive one turn through an ACP agent CLI (Agent Client Protocol: JSON-RPC
 * 2.0 over stdio). The CLI owns model calls and tools; AiWorkHarness renders
 * deltas, answers permission and fs requests, and relays steering as
 * follow-up prompts once the current one ends.
 */
export async function runAcpEngine(
	rt: EngineRuntime,
	spec: { id: EngineId; label: string; args: string[] },
	deps: AcpDeps = defaultDeps(spec.id),
): Promise<{ text: string; sessionId?: string }> {
	const binary = await deps.resolveBinary();
	if (!binary) throw new Error(`${spec.label} engine: the ${spec.id} CLI was not found on PATH`);
	const child = deps.spawn(binary, spec.args, rt.workspaceRoot);

	return await new Promise<{ text: string; sessionId?: string }>((resolvePromise, rejectPromise) => {
		const connection = new AcpConnection(spec.id);
		let settled = false;
		let sessionId: string | undefined;
		let lastText = "";
		const pending = new Map<string | number, (value: { result?: unknown; error?: any }) => void>();
		const steeringQueue: string[] = [];
		let awaitingPrompt = false;
		const stderrTail: string[] = [];

		const writeMessage = (message: unknown) => {
			const stdin = child.stdin;
			if (!stdin || stdin.writableEnded) return; // stdin may already be closed
			try { stdin.write(`${JSON.stringify(message)}\n`); } catch { /* stdin may already be closed */ }
		};

		const settle = (result: { ok: true; value: { text: string; sessionId?: string } } | { ok: false; error: Error }) => {
			if (settled) return;
			settled = true;
			clearInterval(steeringTimer);
			rt.signal.removeEventListener("abort", onAbort);
			if (result.ok) resolvePromise(result.value);
			else rejectPromise(result.error);
		};

		const sendPrompt = (text: string) => {
			if (!sessionId) return;
			awaitingPrompt = true;
			writeMessage(connection.promptMessage(sessionId, text));
		};

		// Steering queued mid-run is sent as a follow-up prompt after the current
		// one ends (one prompt may be in flight; queueing keeps the order stable).
		const steeringTimer = setInterval(() => {
			rt.drainSteering().then((messages) => {
				for (const text of messages) {
					if (awaitingPrompt || !sessionId) steeringQueue.push(text);
					else sendPrompt(text);
				}
			}).catch(() => { /* steering is best-effort */ });
		}, 500);

		const onAbort = () => {
			if (sessionId) writeMessage(connection.cancelNotification(sessionId));
			deps.killTree(child.pid);
			settle({ ok: true, value: { text: lastText, sessionId } });
		};
		if (rt.signal.aborted) onAbort();
		else rt.signal.addEventListener("abort", onAbort, { once: true });

		const sendRequest = (message: unknown, id: string | number): Promise<{ result?: unknown; error?: any }> => {
			writeMessage(message);
			return new Promise((res) => pending.set(id, res));
		};

		const handlePermission = async (action: Extract<AcpAction, { kind: "permission" }>): Promise<void> => {
			let approved = false;
			try { approved = await rt.approve(action.toolName, action.input, action.callId); } catch { approved = false; }
			if (rt.signal.aborted) approved = false;
			writeMessage(permissionResponse(action.requestId, action.options, approved));
		};

		const handleReadFile = async (action: Extract<AcpAction, { kind: "read-file" }>): Promise<void> => {
			if (!isInsideWorkspace(rt.workspaceRoot, action.path)) {
				writeMessage(acpErrorResponse(action.requestId, `Path is outside the workspace: ${action.path}`));
				return;
			}
			try {
				writeMessage(acpResultResponse(action.requestId, { content: await deps.readTextFile(action.path) }));
			} catch (error) {
				writeMessage(acpErrorResponse(action.requestId, `Could not read file: ${error instanceof Error ? error.message : String(error)}`));
			}
		};

		const handleWriteFile = async (action: Extract<AcpAction, { kind: "write-file" }>): Promise<void> => {
			let approved = false;
			try { approved = await rt.approve("write", { path: action.path }, undefined); } catch { approved = false; }
			if (rt.signal.aborted) approved = false;
			if (!approved) {
				writeMessage(acpErrorResponse(action.requestId, "Write denied by the user in AiWorkHarness"));
				return;
			}
			try {
				await deps.writeTextFile(action.path, action.content);
				rt.onAfterEdit?.(action.path);
				writeMessage(acpResultResponse(action.requestId, {}));
			} catch (error) {
				writeMessage(acpErrorResponse(action.requestId, `Could not write file: ${error instanceof Error ? error.message : String(error)}`));
			}
		};

		const handleActions = (actions: AcpAction[]) => {
			for (const action of actions) {
				switch (action.kind) {
					case "emit":
						if (action.event.type === "text-delta") lastText += action.event.text;
						rt.emit(action.event);
						break;
					case "session":
						sessionId = action.sessionId;
						break;
					case "response": {
						const resolver = pending.get(action.id);
						pending.delete(action.id);
						resolver?.({ result: action.result, error: action.error });
						break;
					}
					case "auth-required":
						settle({ ok: false, error: new Error(`${spec.label} engine requires authentication: ${action.instructions}, then retry`) });
						break;
					case "prompt-result":
						awaitingPrompt = false;
						if (steeringQueue.length) sendPrompt(steeringQueue.shift()!);
						else if (!rt.signal.aborted) settle({ ok: true, value: { text: lastText, sessionId } });
						break;
					case "rpc-error":
						settle({ ok: false, error: new Error(`${spec.label} engine: ${action.message}`) });
						break;
					case "permission":
						void handlePermission(action);
						break;
					case "read-file":
						void handleReadFile(action);
						break;
					case "write-file":
						void handleWriteFile(action);
						break;
					case "respond":
						writeMessage(action.message);
						break;
				}
			}
		};

		// Handshake: initialize → session/new → first prompt. Each step waits for
		// its response so the ids stay sequential on the wire.
		void (async () => {
			try {
				const init = connection.initializeMessage();
				const initResponse = await sendRequest(init, init.id);
				if (initResponse.error) throw new Error(`${spec.label} engine: initialize failed: ${String(initResponse.error?.message ?? "unknown error")}`);
				const session = connection.newSessionMessage(rt.workspaceRoot);
				const sessionResponse = await sendRequest(session, session.id);
				const newSessionId = (sessionResponse.result as any)?.sessionId;
				if (typeof newSessionId !== "string" || !newSessionId) throw new Error(`${spec.label} engine: the agent did not return a session id`);
				if (settled) return; // aborted or failed while the handshake was in flight
				sessionId = newSessionId;
				sendPrompt(buildPromptWithHistory(rt.history, rt.prompt));
			} catch (error) {
				settle({ ok: false, error: error instanceof Error ? error : new Error(String(error)) });
			}
		})();

		let stdoutBuffer = "";
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdoutBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			let index: number;
			while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
				const line = stdoutBuffer.slice(0, index);
				stdoutBuffer = stdoutBuffer.slice(index + 1);
				handleActions(connection.handle(line));
			}
		});

		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderrTail.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
			if (stderrTail.length > 40) stderrTail.splice(0, stderrTail.length - 40);
		});

		child.on("error", (err) => {
			settle({ ok: false, error: new Error(`${spec.label} engine failed to start: ${err.message}`) });
		});
		child.on("exit", (code) => {
			if (settled) return;
			const tail = stderrTail.join("").trim();
			settle({ ok: false, error: new Error(`${spec.label} engine exited (code ${code ?? "signal"}) before a result${tail ? `: ${tail.slice(-800)}` : ""}`) });
		});
	});
}

/** Factory for an ACP-speaking CLI: one settings entry per agent. Launch args come from the registry. */
export function createAcpEngine(id: Exclude<EngineId, "builtin">, label: string, args: string[]): AgentEngine {
	return {
		id,
		label,
		async available() {
			const binary = await resolveEngineBinary(id);
			return cachedAvailability(id, binary, async () =>
				binary ? { ok: true, detail: binary } : { ok: false, detail: `the ${id} CLI was not found on PATH` });
		},
		run(rt) {
			return runAcpEngine(rt, { id, label, args });
		},
	};
}
