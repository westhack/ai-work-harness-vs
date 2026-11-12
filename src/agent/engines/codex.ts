/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ChildProcess } from "node:child_process";
import type { AgentEvent } from "../types";
import type { AgentEngine, EngineRuntime } from "./types";
import { buildPromptWithHistory } from "./dispatch";
import { cachedAvailability, ENGINE_LAUNCH_ARGS, killProcessTree, resolveEngineBinary, spawnCommand } from "./registry";

export interface CodexUsage {
	input_tokens?: number;
	output_tokens?: number;
	cached_input_tokens?: number;
}

/**
 * One decoded action per NDJSON line. Emissions map onto AgentEvent; the
 * terminal result is executed by the run loop. Field names are read loosely
 * because they shift between codex releases.
 */
export type CodexAction =
	| { kind: "emit"; event: AgentEvent }
	| { kind: "session"; sessionId: string }
	| { kind: "result"; text: string; usage?: CodexUsage }
	| { kind: "error"; message: string };

function stringifyToolResult(content: unknown): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	return JSON.stringify(content);
}

/**
 * Stateful NDJSON parser for `codex exec --json`. Pure with respect to I/O —
 * every outcome is returned as actions so tests can feed recorded lines
 * without spawning the CLI.
 */
export class CodexStreamParser {
	private streamedItems = new Set<string>();

	handle(line: string): CodexAction[] {
		const trimmed = line.trim();
		if (!trimmed) return [];
		let msg: any;
		try { msg = JSON.parse(trimmed); } catch { return []; }
		switch (msg?.type) {
			case "thread.started":
				return typeof msg.thread_id === "string" && msg.thread_id
					? [{ kind: "session", sessionId: msg.thread_id }]
					: [];
			case "item.started":
			case "item.updated":
				return this.handleItem(msg.item, true);
			case "item.completed":
				return this.handleItem(msg.item, false);
			case "turn.completed": {
				const usage = msg.usage as CodexUsage | undefined;
				return [{ kind: "result", text: "", usage: usage ? {
					input_tokens: Number(usage.input_tokens ?? 0),
					output_tokens: Number(usage.output_tokens ?? 0),
					cached_input_tokens: usage.cached_input_tokens,
				} : undefined }];
			}
			case "turn.failed":
				return [{ kind: "error", message: String(msg.error?.message ?? msg.message ?? "turn failed") }];
			case "error":
				return [{ kind: "error", message: String(msg.message ?? "codex error") }];
			default:
				return [];
		}
	}

	private handleItem(item: any, streaming: boolean): CodexAction[] {
		if (!item) return [];
		const itemId = item.id !== undefined && item.id !== null ? String(item.id) : "";
		switch (item.type) {
			case "agent_message": {
				const text = typeof item.text === "string" ? item.text : "";
				if (!text) return [];
				if (streaming) {
					this.streamedItems.add(itemId);
					return [{ kind: "emit", event: { type: "text-delta", text } }];
				}
				// Completed replays an already-streamed message — emit only once.
				if (itemId && this.streamedItems.has(itemId)) return [];
				return [{ kind: "emit", event: { type: "text-delta", text } }];
			}
			case "reasoning": {
				const text = typeof item.text === "string" ? item.text : "";
				return streaming && text ? [{ kind: "emit", event: { type: "thinking-delta", text } }] : [];
			}
			case "command_execution":
				return this.handleToolItem(item, itemId, streaming, "bash", { command: item.command ?? "" },
					typeof item.exit_code === "number" && item.exit_code !== 0 ? "error" : "completed",
					typeof item.aggregated_output === "string" ? item.aggregated_output : stringifyToolResult(item.aggregated_output));
			case "file_change":
				return this.handleToolItem(item, itemId, streaming, "edit", item.changes ?? {}, "completed",
					stringifyToolResult(item.changes ?? {}));
			default:
				return [];
		}
	}

	private handleToolItem(item: any, itemId: string, streaming: boolean, name: string, input: unknown, status: "completed" | "error", result: string): CodexAction[] {
		const callId = itemId || name;
		if (streaming) return [{ kind: "emit", event: { type: "tool-call-started", callId, name, input } }];
		return [{ kind: "emit", event: { type: "tool-call-completed", callId, name, status, result } }];
	}
}

export interface CodexDeps {
	spawn: (binary: string, args: string[], cwd: string) => ChildProcess;
	resolveBinary: () => Promise<string | undefined>;
	killTree: (pid: number | undefined) => void;
}

function defaultDeps(): CodexDeps {
	return {
		spawn: (binary, args, cwd) => spawnCommand(binary, args, { cwd }),
		resolveBinary: () => resolveEngineBinary("codex"),
		killTree: killProcessTree,
	};
}

/**
 * Drive one turn through `codex exec`. exec mode has no interactive approval
 * channel (the sandbox restricts writes), so tool events are display-only.
 */
export async function runCodex(rt: EngineRuntime, deps: CodexDeps = defaultDeps()): Promise<{ text: string; sessionId?: string }> {
	const binary = await deps.resolveBinary();
	if (!binary) throw new Error("Codex engine: the codex CLI was not found on PATH");
	const args = [...(ENGINE_LAUNCH_ARGS.codex ?? []), "--cd", rt.workspaceRoot, buildPromptWithHistory(rt.history, rt.prompt)];
	const child = deps.spawn(binary, args, rt.workspaceRoot);

	return await new Promise<{ text: string; sessionId?: string }>((resolve, reject) => {
		const parser = new CodexStreamParser();
		let settled = false;
		let sessionId: string | undefined;
		let lastText = "";
		const stderrTail: string[] = [];

		const onAbort = () => deps.killTree(child.pid);
		if (rt.signal.aborted) onAbort();
		else rt.signal.addEventListener("abort", onAbort, { once: true });

		const settle = (result: { ok: true; value: { text: string; sessionId?: string } } | { ok: false; error: Error }) => {
			if (settled) return;
			settled = true;
			rt.signal.removeEventListener("abort", onAbort);
			if (result.ok) resolve(result.value);
			else reject(result.error);
		};

		const handleActions = (actions: CodexAction[]) => {
			for (const action of actions) {
				if (action.kind === "emit") {
					if (action.event.type === "text-delta") lastText += action.event.text;
					rt.emit(action.event);
				} else if (action.kind === "session") {
					sessionId = action.sessionId;
				} else if (action.kind === "result") {
					const usage = action.usage;
					if (usage) {
						rt.emit({
							type: "usage",
							promptTokens: usage.input_tokens ?? 0,
							completionTokens: usage.output_tokens ?? 0,
							totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
							source: "parent",
							cachedReadTokens: usage.cached_input_tokens,
						});
					}
					rt.emit({ type: "run-result", text: lastText, durationMs: 0 });
					settle({ ok: true, value: { text: lastText, sessionId } });
				} else if (action.kind === "error") {
					settle({ ok: false, error: new Error(`Codex engine: ${action.message}`) });
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
			settle({ ok: false, error: new Error(`Codex engine failed to start: ${err.message}`) });
		});
		child.on("exit", (code) => {
			if (settled) return;
			const tail = stderrTail.join("").trim();
			settle({ ok: false, error: new Error(`Codex engine exited (code ${code ?? "signal"}) before a result${tail ? `: ${tail.slice(-800)}` : ""}`) });
		});
	});
}

export const codexEngine: AgentEngine = {
	id: "codex",
	label: "Codex",
	async available() {
		const binary = await resolveEngineBinary("codex");
		return cachedAvailability("codex", binary, async () =>
			binary ? { ok: true, detail: binary } : { ok: false, detail: "the codex CLI was not found on PATH" });
	},
	run(rt) {
		return runCodex(rt);
	},
};
