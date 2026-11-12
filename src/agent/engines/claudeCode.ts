/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ChildProcess } from "node:child_process";
import type { AgentEvent } from "../types";
import type { AgentEngine, EngineRuntime } from "./types";
import { cachedAvailability, killProcessTree, resolveEngineBinary, spawnCommand } from "./registry";
import { claudeBridgeLaunch, removeClaudeSettingsFile, writeClaudeSettingsFile } from "./bridgeEnv";

/** Spawn flags verified against claude 2.1.322 (stdio JSON protocol). */
const CLAUDE_ARGS = [
	"-p", "--input-format", "stream-json", "--output-format", "stream-json",
	"--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio",
	"--permission-mode", "default",
];

export interface ClaudeUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

/**
 * One decoded action per NDJSON line. Emissions map straight onto AgentEvent;
 * control requests and the terminal result are executed by the run loop.
 */
export type ClaudeAction =
	| { kind: "emit"; event: AgentEvent }
	| { kind: "session"; sessionId: string }
	| { kind: "control-request"; requestId: string; toolName: string; input: unknown; callId?: string }
	| { kind: "result"; text: string; isError: boolean; usage?: ClaudeUsage; durationMs?: number };

function stringifyToolResult(content: unknown): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((block) => {
			const item = block as { type?: string; text?: string };
			return typeof item?.text === "string" ? item.text : JSON.stringify(block);
		}).join("\n");
	}
	return JSON.stringify(content);
}

/**
 * Stateful NDJSON parser for the Claude Code stream-json protocol. Pure with
 * respect to I/O — every outcome is returned as actions so tests can feed
 * recorded lines without spawning the CLI.
 */
export class ClaudeStreamParser {
	private streamedMessageIds = new Set<string>();
	private toolNames = new Map<string, string>();

	handle(line: string): ClaudeAction[] {
		const trimmed = line.trim();
		if (!trimmed) return [];
		let msg: any;
		try { msg = JSON.parse(trimmed); } catch { return []; }
		switch (msg?.type) {
			case "system": return this.handleSystem(msg);
			case "stream_event": return this.handleStreamEvent(msg);
			case "assistant": return this.handleAssistant(msg);
			case "user": return this.handleUser(msg);
			case "control_request": return this.handleControlRequest(msg);
			case "result": return this.handleResult(msg);
			default: return [];
		}
	}

	private handleSystem(msg: any): ClaudeAction[] {
		if (msg.subtype === "init" && typeof msg.session_id === "string") {
			return [{ kind: "session", sessionId: msg.session_id }];
		}
		if (msg.subtype === "api_retry") {
			return [{ kind: "emit", event: {
				type: "retry",
				attempt: Number(msg.attempt ?? 0),
				max: Number(msg.max_retries ?? 0),
				delayMs: Number(msg.retry_delay_ms ?? 0),
				error: typeof msg.error === "string" ? msg.error : String(msg.error?.message ?? msg.error ?? "retry"),
			} }];
		}
		return [];
	}

	private handleStreamEvent(msg: any): ClaudeAction[] {
		const event = msg.event ?? {};
		if (event.type === "message_start" && event.message?.id) {
			// The final assistant message will replay this content; remember it so
			// the fallback emit below does not duplicate the streamed deltas.
			this.streamedMessageIds.add(String(event.message.id));
			return [];
		}
		if (event.type !== "content_block_delta") return [];
		const delta = event.delta ?? {};
		if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
			return [{ kind: "emit", event: { type: "text-delta", text: delta.text } }];
		}
		if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
			return [{ kind: "emit", event: { type: "thinking-delta", text: delta.thinking } }];
		}
		return [];
	}

	private handleAssistant(msg: any): ClaudeAction[] {
		const message = msg.message ?? {};
		const streamed = typeof message.id === "string" && this.streamedMessageIds.has(message.id);
		const actions: ClaudeAction[] = [];
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block?.type === "text" && typeof block.text === "string" && block.text && !streamed) {
				// No partial messages arrived for this reply — emit it whole.
				actions.push({ kind: "emit", event: { type: "text-delta", text: block.text } });
			} else if (block?.type === "tool_use") {
				if (typeof block.id === "string" && typeof block.name === "string") this.toolNames.set(block.id, block.name);
				actions.push({ kind: "emit", event: {
					type: "tool-call-started",
					callId: String(block.id ?? ""),
					name: String(block.name ?? ""),
					input: block.input ?? {},
				} });
			}
		}
		if (typeof message.id === "string") this.streamedMessageIds.add(message.id);
		return actions;
	}

	private handleUser(msg: any): ClaudeAction[] {
		const actions: ClaudeAction[] = [];
		for (const block of Array.isArray(msg.message?.content) ? msg.message.content : []) {
			if (block?.type !== "tool_result") continue;
			const callId = String(block.tool_use_id ?? "");
			actions.push({ kind: "emit", event: {
				type: "tool-call-completed",
				callId,
				name: this.toolNames.get(callId) ?? callId,
				status: block.is_error ? "error" : "completed",
				result: stringifyToolResult(block.content),
			} });
		}
		return actions;
	}

	private handleControlRequest(msg: any): ClaudeAction[] {
		const request = msg.request ?? {};
		if (request.subtype !== "can_use_tool") return [];
		return [{ kind: "control-request",
			requestId: String(msg.request_id ?? msg.requestId ?? ""),
			toolName: String(request.tool_name ?? ""),
			input: request.input ?? {},
			callId: request.tool_use_id ? String(request.tool_use_id) : undefined,
		}];
	}

	private handleResult(msg: any): ClaudeAction[] {
		const usage = msg.usage as ClaudeUsage | undefined;
		return [{ kind: "result",
			text: typeof msg.result === "string" ? msg.result : "",
			isError: msg.is_error === true,
			usage: usage ? {
				input_tokens: Number(usage.input_tokens ?? 0),
				output_tokens: Number(usage.output_tokens ?? 0),
				cache_read_input_tokens: usage.cache_read_input_tokens,
				cache_creation_input_tokens: usage.cache_creation_input_tokens,
			} : undefined,
			durationMs: typeof msg.duration_ms === "number" ? msg.duration_ms : undefined,
		}];
	}
}

export interface ClaudeCodeDeps {
	spawn: (binary: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => ChildProcess;
	resolveBinary: () => Promise<string | undefined>;
	killTree: (pid: number | undefined) => void;
}

function defaultDeps(): ClaudeCodeDeps {
	return {
		spawn: (binary, args, cwd, env) => spawnCommand(binary, args, { cwd, env }),
		resolveBinary: () => resolveEngineBinary("claude-code"),
		killTree: killProcessTree,
	};
}

/**
 * Drive one turn through the Claude Code CLI. The CLI owns model calls, tools
 * and retries; AiWorkHarness renders deltas and answers permission requests.
 */
export async function runClaudeCode(rt: EngineRuntime, deps: ClaudeCodeDeps = defaultDeps()): Promise<{ text: string; sessionId?: string }> {
	const binary = await deps.resolveBinary();
	if (!binary) throw new Error("Claude Code engine: the claude CLI was not found on PATH or in VS Code extensions");
	const launch = await claudeBridgeLaunch();
	const settingsFile = launch?.settings ? writeClaudeSettingsFile(launch.settings) : undefined;
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		removeClaudeSettingsFile(settingsFile);
	};
	const args = [
		...CLAUDE_ARGS,
		...(settingsFile ? ["--settings", settingsFile] : []),
		...(launch?.model ? ["--model", launch.model] : []),
	];
	let child: ChildProcess;
	try {
		child = deps.spawn(binary, args, rt.workspaceRoot, launch?.env);
	} catch (error) {
		cleanup();
		throw error;
	}

	return await new Promise<{ text: string; sessionId?: string }>((resolve, reject) => {
		const parser = new ClaudeStreamParser();
		let settled = false;
		let sessionId: string | undefined;
		let lastText = "";
		const stderrTail: string[] = [];

		const writeMessage = (text: string) => {
			const stdin = child.stdin;
			if (!stdin || stdin.writableEnded) return; // stdin may already be closed
			try {
				stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`);
			} catch { /* stdin may already be closed */ }
		};

		const onAbort = () => {
			deps.killTree(child.pid);
			cleanup();
		};
		if (rt.signal.aborted) onAbort();
		else rt.signal.addEventListener("abort", onAbort, { once: true });

		const settle = (result: { ok: true; value: { text: string; sessionId?: string } } | { ok: false; error: Error }) => {
			if (settled) return;
			settled = true;
			clearInterval(steeringTimer);
			rt.signal.removeEventListener("abort", onAbort);
			cleanup();
			if (result.ok) resolve(result.value);
			else reject(result.error);
		};

		// Steering queued mid-run is appended as follow-up user messages.
		const steeringTimer = setInterval(() => {
			rt.drainSteering().then((messages) => {
				for (const text of messages) writeMessage(text);
			}).catch(() => { /* steering is best-effort */ });
		}, 500);

		const handleControlRequest = async (action: Extract<ClaudeAction, { kind: "control-request" }>) => {
			let approved = false;
			try { approved = await rt.approve(action.toolName, action.input, action.callId); } catch { approved = false; }
			const response = {
				type: "control_response",
				response: {
					subtype: "success",
					request_id: action.requestId,
					response: approved
						? { behavior: "allow", updatedInput: action.input }
						: { behavior: "deny", message: "Denied by the user in AiWorkHarness" },
				},
			};
			const stdin = child.stdin;
			if (!stdin || stdin.writableEnded) return;
			try { stdin.write(`${JSON.stringify(response)}\n`); } catch { /* stdin may already be closed */ }
		};

		const handleActions = (actions: ClaudeAction[]) => {
			for (const action of actions) {
				if (action.kind === "emit") {
					if (action.event.type === "text-delta") lastText += action.event.text;
					rt.emit(action.event);
				} else if (action.kind === "session") {
					sessionId = action.sessionId;
				} else if (action.kind === "control-request") {
					void handleControlRequest(action);
				} else if (action.kind === "result") {
					const usage = action.usage;
					if (usage) {
						rt.emit({
							type: "usage",
							promptTokens: usage.input_tokens ?? 0,
							completionTokens: usage.output_tokens ?? 0,
							totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
							source: "parent",
							cachedReadTokens: usage.cache_read_input_tokens,
							cachedWriteTokens: usage.cache_creation_input_tokens,
						});
					}
					rt.emit({ type: "run-result", text: action.text, durationMs: action.durationMs ?? 0 });
					settle({ ok: true, value: { text: action.text || lastText, sessionId } });
				}
			}
		};

		let stdoutBuffer = "";
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdoutBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			let index: number;
			while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
				const line = stdoutBuffer.slice(0, index);
				stdoutBuffer = stdoutBuffer.slice(index + 1);
				handleActions(parser.handle(line));
			}
		});

		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderrTail.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
			if (stderrTail.length > 40) stderrTail.splice(0, stderrTail.length - 40);
		});

		child.on("error", (err) => {
			settle({ ok: false, error: new Error(`Claude Code engine failed to start: ${err.message}`) });
		});
		child.on("exit", (code) => {
			if (settled) return;
			const tail = stderrTail.join("").trim();
			settle({ ok: false, error: new Error(`Claude Code engine exited (code ${code ?? "signal"}) before a result${tail ? `: ${tail.slice(-800)}` : ""}`) });
		});

		writeMessage(rt.prompt);
	});
}

export const claudeCodeEngine: AgentEngine = {
	id: "claude-code",
	label: "Claude Code",
	async available() {
		const binary = await resolveEngineBinary("claude-code");
		return cachedAvailability("claude-code", binary, async () =>
			binary ? { ok: true, detail: binary } : { ok: false, detail: "the claude CLI was not found on PATH or in VS Code extensions" });
	},
	run(rt) {
		return runClaudeCode(rt);
	},
};
