/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { runCodex, CodexStreamParser } from "./codex";
import type { CodexDeps } from "./codex";
import { buildPromptWithHistory } from "./dispatch";
import type { AgentEvent } from "../types";
import type { EngineRuntime } from "./types";

type FakeChild = Omit<ChildProcess, "stdout" | "stderr" | "stdin"> & {
	stdout: EventEmitter;
	stderr: EventEmitter;
	stdin: { write: ReturnType<typeof vi.fn>; writableEnded: boolean };
	pid: number;
};

function fakeChild(): FakeChild {
	const child = new EventEmitter() as unknown as FakeChild;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = { write: vi.fn(), writableEnded: false };
	child.pid = 4242;
	return child;
}

function runtime(opts: { signal?: AbortSignal } = {}) {
	const emit = vi.fn();
	const rt: EngineRuntime = {
		workspaceRoot: "H:/ws",
		prompt: "do the thing",
		history: [],
		mode: "agent",
		runId: "run_1",
		signal: opts.signal ?? new AbortController().signal,
		emit,
		approve: vi.fn(async () => true),
		drainSteering: vi.fn(async () => [] as string[]),
	};
	return { rt, emit };
}

function depsFor(child: FakeChild): CodexDeps & { spawn: ReturnType<typeof vi.fn>; killTree: ReturnType<typeof vi.fn> } {
	return {
		spawn: vi.fn(() => child as unknown as ChildProcess),
		resolveBinary: async () => "C:/bin/codex.exe",
		killTree: vi.fn(),
	};
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const sendLines = (child: FakeChild, lines: unknown[]) =>
	child.stdout.emit("data", Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8"));

const eventTypes = (emit: ReturnType<typeof vi.fn>) => emit.mock.calls.map((call) => (call[0] as AgentEvent).type);

describe("CodexStreamParser", () => {
	it("records the thread id from thread.started", () => {
		const parser = new CodexStreamParser();
		expect(parser.handle(JSON.stringify({ type: "thread.started", thread_id: "th_1" })))
			.toEqual([{ kind: "session", sessionId: "th_1" }]);
		expect(parser.handle(JSON.stringify({ type: "thread.started" }))).toEqual([]);
	});

	it("maps agent_message items, emitting the completed message only when unstreamed", () => {
		const parser = new CodexStreamParser();
		expect(parser.handle(JSON.stringify({ type: "item.started", item: { id: "m1", type: "agent_message", text: "Hi" } })))
			.toEqual([{ kind: "emit", event: { type: "text-delta", text: "Hi" } }]);
		// completed replays the streamed message → no duplicate
		expect(parser.handle(JSON.stringify({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "Hi" } }))).toEqual([]);
		// a message that never streamed is emitted whole
		expect(parser.handle(JSON.stringify({ type: "item.completed", item: { id: "m2", type: "agent_message", text: "done" } })))
			.toEqual([{ kind: "emit", event: { type: "text-delta", text: "done" } }]);
	});

	it("maps reasoning, command_execution and file_change items", () => {
		const parser = new CodexStreamParser();
		expect(parser.handle(JSON.stringify({ type: "item.updated", item: { id: "r1", type: "reasoning", text: "thinking" } })))
			.toEqual([{ kind: "emit", event: { type: "thinking-delta", text: "thinking" } }]);
		expect(parser.handle(JSON.stringify({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "thinking" } }))).toEqual([]);
		expect(parser.handle(JSON.stringify({ type: "item.started", item: { id: "c1", type: "command_execution", command: "ls -la" } })))
			.toEqual([{ kind: "emit", event: { type: "tool-call-started", callId: "c1", name: "bash", input: { command: "ls -la" } } }]);
		expect(parser.handle(JSON.stringify({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls -la", exit_code: 0, aggregated_output: "a\nb" } })))
			.toEqual([{ kind: "emit", event: { type: "tool-call-completed", callId: "c1", name: "bash", status: "completed", result: "a\nb" } }]);
		// non-zero exit code → error status
		expect(parser.handle(JSON.stringify({ type: "item.completed", item: { id: "c2", type: "command_execution", command: "nope", exit_code: 1, aggregated_output: "" } })))
			.toEqual([{ kind: "emit", event: { type: "tool-call-completed", callId: "c2", name: "bash", status: "error", result: "" } }]);
		expect(parser.handle(JSON.stringify({ type: "item.started", item: { id: "f1", type: "file_change", changes: { "a.ts": { kind: "modify" } } } })))
			.toEqual([{ kind: "emit", event: { type: "tool-call-started", callId: "f1", name: "edit", input: { "a.ts": { kind: "modify" } } } }]);
		expect(parser.handle(JSON.stringify({ type: "item.completed", item: { id: "f1", type: "file_change", changes: { "a.ts": { kind: "modify" } } } })))
			.toEqual([{ kind: "emit", event: { type: "tool-call-completed", callId: "f1", name: "edit", status: "completed", result: '{"a.ts":{"kind":"modify"}}' } }]);
		// unknown item types are ignored
		expect(parser.handle(JSON.stringify({ type: "item.completed", item: { id: "x", type: "todo_list" } }))).toEqual([]);
		expect(parser.handle("not json")).toEqual([]);
	});

	it("turn.completed carries usage; turn.failed and error produce errors", () => {
		const parser = new CodexStreamParser();
		expect(parser.handle(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50 } })))
			.toEqual([{ kind: "result", text: "", usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50 } }]);
		expect(parser.handle(JSON.stringify({ type: "turn.failed", error: { message: "quota exceeded" } })))
			.toEqual([{ kind: "error", message: "quota exceeded" }]);
		expect(parser.handle(JSON.stringify({ type: "error", message: "stream broke" })))
			.toEqual([{ kind: "error", message: "stream broke" }]);
	});
});

describe("runCodex", () => {
	it("drives a full turn: spawn args, tool events, usage, run-result and resolve", async () => {
		const child = fakeChild();
		const deps = depsFor(child);
		const { rt, emit } = runtime();
		const promise = runCodex(rt, deps);
		await flush();

		expect(deps.spawn).toHaveBeenCalledWith(
			"C:/bin/codex.exe",
			["exec", "--json", "--sandbox", "workspace-write", "--cd", "H:/ws", "do the thing"],
			"H:/ws",
		);

		sendLines(child, [
			{ type: "thread.started", thread_id: "th_9" },
			{ type: "item.started", item: { id: "m1", type: "agent_message", text: "Working on it" } },
			{ type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test" } },
			{ type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", exit_code: 0, aggregated_output: "all green" } },
			{ type: "item.completed", item: { id: "m1", type: "agent_message", text: "Working on it" } },
			{ type: "item.completed", item: { id: "m2", type: "agent_message", text: " done" } },
			{ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50 } },
		]);
		await expect(promise).resolves.toEqual({ text: "Working on it done", sessionId: "th_9" });

		expect(eventTypes(emit)).toEqual([
			"text-delta", "tool-call-started", "tool-call-completed", "text-delta", "usage", "run-result",
		]);
		expect(emit.mock.calls.find((call) => call[0].type === "usage")![0]).toEqual({
			type: "usage", promptTokens: 100, completionTokens: 20, totalTokens: 120, source: "parent", cachedReadTokens: 50,
		});
		expect(emit.mock.calls.find((call) => call[0].type === "run-result")![0]).toEqual({
			type: "run-result", text: "Working on it done", durationMs: 0,
		});
	});

	it("prepends the condensed history to the prompt", async () => {
		const child = fakeChild();
		const deps = depsFor(child);
		const { rt } = runtime();
		rt.history = [
			{ role: "user", text: "first ask" },
			{ role: "assistant", text: "first answer" },
		];
		const promise = runCodex(rt, deps);
		await flush();

		const args = deps.spawn.mock.calls[0][1] as string[];
		expect(args.at(-1)).toBe("Previous conversation summary:\nUser: first ask\nAssistant: first answer\n\nCurrent request:\ndo the thing");

		sendLines(child, [{ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }]);
		await expect(promise).resolves.toBeTruthy();
	});

	it("rejects on turn.failed", async () => {
		const child = fakeChild();
		const { rt, emit } = runtime();
		const promise = runCodex(rt, depsFor(child));
		await flush();
		sendLines(child, [{ type: "turn.failed", error: { message: "model overloaded" } }]);
		await expect(promise).rejects.toThrow("Codex engine: model overloaded");
		expect(eventTypes(emit)).toEqual([]);
	});

	it("rejects with the stderr tail when the process exits without a result", async () => {
		const child = fakeChild();
		const { rt } = runtime();
		const promise = runCodex(rt, depsFor(child));
		await flush();
		child.stderr.emit("data", Buffer.from("unrecognized flag"));
		child.emit("exit", 2);
		await expect(promise).rejects.toThrow("Codex engine exited (code 2) before a result: unrecognized flag");
	});

	it("kills the process tree when the run is aborted", async () => {
		const child = fakeChild();
		const controller = new AbortController();
		const deps = depsFor(child);
		const { rt } = runtime({ signal: controller.signal });
		const promise = runCodex(rt, deps);
		await flush();

		controller.abort();
		expect(deps.killTree).toHaveBeenCalledWith(4242);

		sendLines(child, [{ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }]);
		await expect(promise).resolves.toBeTruthy();
	});
});
