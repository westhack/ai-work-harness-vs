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
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const bridgeMock = vi.hoisted(() => ({
	bridgeEndpoint: vi.fn(() => ({ url: "http://127.0.0.1:4321", token: "test-token" })),
	ensureBridge: vi.fn(async () => ({ url: "http://127.0.0.1:4321", token: "test-token" })),
}));

vi.mock("../bridge", () => bridgeMock);

import { runClaudeCode, ClaudeStreamParser } from "./claudeCode";
import type { ClaudeCodeDeps } from "./claudeCode";
import { setBridgeEnvFeatureSource, setBridgeModelSource } from "./bridgeEnv";
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

function runtime(opts: { signal?: AbortSignal; approve?: (toolName: string, input: any, callId?: string) => Promise<boolean> } = {}) {
	const emit = vi.fn();
	const approve = vi.fn(opts.approve ?? (async () => true));
	const drainSteering = vi.fn(async () => [] as string[]);
	const rt: EngineRuntime = {
		workspaceRoot: "H:/ws",
		prompt: "do the thing",
		history: [],
		mode: "agent",
		runId: "run_1",
		signal: opts.signal ?? new AbortController().signal,
		emit,
		approve,
		drainSteering,
	};
	return { rt, emit, approve, drainSteering };
}

function depsFor(child: FakeChild): ClaudeCodeDeps & { spawn: ReturnType<typeof vi.fn> } {
	return {
		spawn: vi.fn(() => child as unknown as ChildProcess),
		resolveBinary: async () => "C:/bin/claude.exe",
		killTree: vi.fn(),
	};
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	setBridgeModelSource(undefined);
	setBridgeEnvFeatureSource(undefined);
	vi.clearAllMocks();
});

const sendLines = (child: FakeChild, lines: unknown[]) =>
	child.stdout.emit("data", Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8"));

const eventTypes = (emit: ReturnType<typeof vi.fn>) => emit.mock.calls.map((call) => (call[0] as AgentEvent).type);

const writtenMessages = (child: FakeChild) => child.stdin.write.mock.calls.map((call) => JSON.parse(call[0] as string));

const INIT = { type: "system", subtype: "init", session_id: "sess_1" };

describe("ClaudeStreamParser", () => {
	it("emits streamed text deltas without replaying them from the final message", () => {
		const parser = new ClaudeStreamParser();
		expect(parser.handle(JSON.stringify(INIT))).toEqual([{ kind: "session", sessionId: "sess_1" }]);
		expect(parser.handle(JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } }))).toEqual([]);
		expect(parser.handle(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } })))
			.toEqual([{ kind: "emit", event: { type: "text-delta", text: "Hello" } }]);
		// The final assistant message replays the same text — no duplicate emit.
		const actions = parser.handle(JSON.stringify({
			type: "assistant",
			message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "Hello" }] },
		}));
		expect(actions).toEqual([]);
	});

	it("emits the whole assistant text once when no partials arrived", () => {
		const parser = new ClaudeStreamParser();
		const actions = parser.handle(JSON.stringify({
			type: "assistant",
			message: { id: "msg_2", role: "assistant", content: [{ type: "text", text: "Hi there" }] },
		}));
		expect(actions).toEqual([{ kind: "emit", event: { type: "text-delta", text: "Hi there" } }]);
		// and never twice for the same message
		expect(parser.handle(JSON.stringify({
			type: "assistant",
			message: { id: "msg_2", role: "assistant", content: [{ type: "text", text: "Hi there" }] },
		}))).toEqual([]);
	});

	it("maps tool_use blocks and resolves their names for tool results", () => {
		const parser = new ClaudeStreamParser();
		expect(parser.handle(JSON.stringify({
			type: "assistant",
			message: { id: "msg_3", content: [{ type: "tool_use", id: "tool_1", name: "Shell", input: { command: "ls" } }] },
		}))).toEqual([{ kind: "emit", event: { type: "tool-call-started", callId: "tool_1", name: "Shell", input: { command: "ls" } } }]);
		expect(parser.handle(JSON.stringify({
			type: "user",
			message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: [{ type: "text", text: "out" }], is_error: false }] },
		}))).toEqual([{ kind: "emit", event: { type: "tool-call-completed", callId: "tool_1", name: "Shell", status: "completed", result: "out" } }]);
	});

	it("maps api_retry, thinking deltas, control requests and errors", () => {
		const parser = new ClaudeStreamParser();
		expect(parser.handle(JSON.stringify({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 5, retry_delay_ms: 800, error: "boom" })))
			.toEqual([{ kind: "emit", event: { type: "retry", attempt: 2, max: 5, delayMs: 800, error: "boom" } }]);
		expect(parser.handle(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } })))
			.toEqual([{ kind: "emit", event: { type: "thinking-delta", text: "hmm" } }]);
		expect(parser.handle(JSON.stringify({ type: "control_request", request_id: "req_9", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm" } } })))
			.toEqual([{ kind: "control-request", requestId: "req_9", toolName: "Bash", input: { command: "rm" }, callId: undefined }]);
		expect(parser.handle("not json")).toEqual([]);
	});
});

describe("runClaudeCode", () => {
	it("drives a full turn: deltas, tool, permission approval, usage and result", async () => {
		const child = fakeChild();
		const deps = depsFor(child);
		const { rt, emit, approve } = runtime();
		const promise = runClaudeCode(rt, deps);
		await flush();

		expect(deps.spawn).toHaveBeenCalledWith("C:/bin/claude.exe", expect.any(Array), "H:/ws", undefined);
		// First stdin message carries the prompt.
		expect(writtenMessages(child)[0]).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } });

		sendLines(child, [
			INIT,
			{ type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } },
			{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } },
			{ type: "assistant", message: { id: "msg_1", content: [
				{ type: "text", text: "Hello" },
				{ type: "tool_use", id: "tool_1", name: "Shell", input: { command: "ls" } },
			] } },
			{ type: "control_request", request_id: "req_1", request: { subtype: "can_use_tool", tool_name: "Shell", input: { command: "ls" }, tool_use_id: "tool_1" } },
			{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: [{ type: "text", text: "out" }], is_error: false }] } },
		]);
		await flush();

		expect(approve).toHaveBeenCalledWith("Shell", { command: "ls" }, "tool_1");
		expect(writtenMessages(child).at(-1)).toEqual({
			type: "control_response",
			response: { subtype: "success", request_id: "req_1", response: { behavior: "allow", updatedInput: { command: "ls" } } },
		});

		sendLines(child, [
			{ type: "result", session_id: "sess_1", is_error: false, result: "done", duration_ms: 1234, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 } },
		]);
		await expect(promise).resolves.toEqual({ text: "done", sessionId: "sess_1" });

		expect(eventTypes(emit)).toEqual(["text-delta", "tool-call-started", "tool-call-completed", "usage", "run-result"]);
		expect(emit.mock.calls.find((call) => call[0].type === "usage")![0]).toEqual({
			type: "usage", promptTokens: 100, completionTokens: 20, totalTokens: 120, source: "parent", cachedReadTokens: 50, cachedWriteTokens: 5,
		});
		expect(emit.mock.calls.find((call) => call[0].type === "run-result")![0]).toEqual({ type: "run-result", text: "done", durationMs: 1234 });
	});

	it("writes a deny control_response when approval is refused", async () => {
		const child = fakeChild();
		const { rt } = runtime({ approve: async () => false });
		const promise = runClaudeCode(rt, depsFor(child));
		await flush();

		sendLines(child, [
			INIT,
			{ type: "control_request", request_id: "req_2", request: { subtype: "can_use_tool", tool_name: "Write", input: { path: "a.ts" } } },
		]);
		await flush();
		expect(writtenMessages(child).at(-1)?.response.response).toEqual({ behavior: "deny", message: "Denied by the user in AiWorkHarness" });

		sendLines(child, [{ type: "result", session_id: "sess_1", is_error: false, result: "stopped", duration_ms: 10 }]);
		await expect(promise).resolves.toEqual({ text: "stopped", sessionId: "sess_1" });
	});

	it("rejects with the stderr tail when the process exits without a result", async () => {
		const child = fakeChild();
		const { rt, emit } = runtime();
		const promise = runClaudeCode(rt, depsFor(child));
		await flush();

		child.stderr.emit("data", Buffer.from("fatal: bad config"));
		child.emit("exit", 1);
		await expect(promise).rejects.toThrow("Claude Code engine exited (code 1) before a result: fatal: bad config");
		// Engine failures propagate to the host error path — no duplicate emit here.
		expect(eventTypes(emit)).toEqual([]);
	});

	it("kills the process tree when the run is aborted", async () => {
		const child = fakeChild();
		const controller = new AbortController();
		const deps = depsFor(child);
		const { rt } = runtime({ signal: controller.signal });
		const promise = runClaudeCode(rt, deps);
		await flush();

		controller.abort();
		expect(deps.killTree).toHaveBeenCalledWith(4242);

		sendLines(child, [INIT, { type: "result", session_id: "sess_1", is_error: false, result: "late", duration_ms: 1 }]);
		await expect(promise).resolves.toEqual({ text: "late", sessionId: "sess_1" });
	});

	it("appends drained steering as follow-up user messages", async () => {
		const child = fakeChild();
		const { rt, drainSteering } = runtime();
		drainSteering.mockResolvedValue(["use tabs"]);
		const promise = runClaudeCode(rt, depsFor(child));
		await flush();
		await new Promise<void>((resolve) => setTimeout(resolve, 550)); // steering interval is 500ms

		expect(writtenMessages(child).at(-1)).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "use tabs" }] } });

		sendLines(child, [INIT, { type: "result", session_id: "sess_1", is_error: false, result: "ok", duration_ms: 1 }]);
		await expect(promise).resolves.toEqual({ text: "ok", sessionId: "sess_1" });
	});
});

describe("runClaudeCode bridge wiring", () => {
	const enableBridge = (model = "anthropic::claude-sonnet-4-5") => {
		setBridgeEnvFeatureSource(() => ({ engineBridgeEnabled: true, engineBridgeModel: model }));
		setBridgeModelSource(() => "gpt-4o");
	};
	const settingsPath = (args: string[]) => args[args.indexOf("--settings") + 1];

	it("spawns without --settings/--model and without env while the bridge is off", async () => {
		const child = fakeChild();
		const deps = depsFor(child);
		const promise = runClaudeCode(runtime().rt, deps);
		await flush();

		const [binary, args, cwd, env] = deps.spawn.mock.calls[0];
		expect(binary).toBe("C:/bin/claude.exe");
		expect(cwd).toBe("H:/ws");
		expect(args).not.toContain("--settings");
		expect(args).not.toContain("--model");
		expect(env).toBeUndefined();

		sendLines(child, [INIT, { type: "result", session_id: "sess_1", is_error: false, result: "ok", duration_ms: 1 }]);
		await expect(promise).resolves.toEqual({ text: "ok", sessionId: "sess_1" });
	});

	it("passes the bridge settings file and bare model through --settings/--model", async () => {
		enableBridge();
		const child = fakeChild();
		const deps = depsFor(child);
		const promise = runClaudeCode(runtime().rt, deps);
		await flush();

		const [, args, , env] = deps.spawn.mock.calls[0];
		const file = settingsPath(args);
		expect(file).toMatch(/aiworkharness-bridge/);
		expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-5");
		expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4321");

		// The file must exist while the CLI runs and carry the same env values.
		expect(existsSync(file)).toBe(true);
		const written = JSON.parse(readFileSync(file, "utf8"));
		expect(written.env.ANTHROPIC_BASE_URL).toBe(env.ANTHROPIC_BASE_URL);
		expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe(env.ANTHROPIC_AUTH_TOKEN);

		sendLines(child, [INIT, { type: "result", session_id: "sess_1", is_error: false, result: "ok", duration_ms: 1 }]);
		await expect(promise).resolves.toEqual({ text: "ok", sessionId: "sess_1" });
		expect(existsSync(file)).toBe(false);
	});

	it("removes the settings file when the CLI exits without a result", async () => {
		enableBridge();
		const child = fakeChild();
		const deps = depsFor(child);
		const promise = runClaudeCode(runtime().rt, deps);
		await flush();

		const file = settingsPath(deps.spawn.mock.calls[0][1]);
		expect(existsSync(file)).toBe(true);
		child.emit("exit", 1);
		await expect(promise).rejects.toThrow("Claude Code engine exited (code 1)");
		expect(existsSync(file)).toBe(false);
	});

	it("removes the settings file when the child errors on start", async () => {
		enableBridge();
		const child = fakeChild();
		const deps = depsFor(child);
		const promise = runClaudeCode(runtime().rt, deps);
		await flush();

		const file = settingsPath(deps.spawn.mock.calls[0][1]);
		child.emit("error", new Error("ENOENT"));
		await expect(promise).rejects.toThrow("failed to start");
		expect(existsSync(file)).toBe(false);
	});

	it("removes the settings file when spawning throws", async () => {
		enableBridge();
		const spawn = vi.fn((_binary: string, _args: string[], _cwd: string, _env?: NodeJS.ProcessEnv): ChildProcess => {
			throw new Error("spawn boom");
		});
		const deps: ClaudeCodeDeps = { spawn, resolveBinary: async () => "C:/bin/claude.exe", killTree: vi.fn() };
		await expect(runClaudeCode(runtime().rt, deps)).rejects.toThrow("spawn boom");
		const file = settingsPath(spawn.mock.calls[0][1]);
		expect(existsSync(file)).toBe(false);
	});
});
