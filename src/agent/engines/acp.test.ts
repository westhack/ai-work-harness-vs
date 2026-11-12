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
import {
	acpErrorResponse,
	AcpConnection,
	isInsideWorkspace,
	permissionResponse,
	runAcpEngine,
} from "./acp";
import type { AcpDeps } from "./acp";
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

function depsFor(child: FakeChild, fs: Partial<Pick<AcpDeps, "readTextFile" | "writeTextFile">> = {}): AcpDeps & { spawn: ReturnType<typeof vi.fn>; killTree: ReturnType<typeof vi.fn> } {
	return {
		spawn: vi.fn(() => child as unknown as ChildProcess),
		resolveBinary: async () => "C:/bin/gemini.exe",
		killTree: vi.fn(),
		readTextFile: vi.fn(async () => "file body"),
		writeTextFile: vi.fn(async () => undefined),
		...fs,
	};
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const sendLines = (child: FakeChild, lines: unknown[]) =>
	child.stdout.emit("data", Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8"));

const writtenMessages = (child: FakeChild) => child.stdin.write.mock.calls.map((call) => JSON.parse(call[0] as string));

const SPEC = { id: "gemini" as const, label: "Gemini CLI", args: ["--experimental-acp"] };

describe("AcpConnection", () => {
	it("builds the initialize request with client capabilities", () => {
		const connection = new AcpConnection("gemini");
		expect(connection.initializeMessage()).toEqual({
			jsonrpc: "2.0", id: 1, method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } },
		});
		expect(connection.newSessionMessage("H:/ws")).toEqual({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "H:/ws", mcpServers: [] } });
		expect(connection.promptMessage("s1", "hi")).toEqual({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] } });
		expect(connection.cancelNotification("s1")).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } });
	});

	it("flags authMethod in the initialize result and otherwise resolves the response", () => {
		const connection = new AcpConnection("gemini");
		connection.initializeMessage();
		expect(connection.handleMessage({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })).toEqual([
			{ kind: "response", id: 1, result: { protocolVersion: 1 }, error: undefined },
		]);
		expect(connection.handleMessage({ jsonrpc: "2.0", id: 1, result: { authMethod: { id: "oauth", name: "Sign in" } } })).toEqual([
			{ kind: "auth-required", instructions: "run `gemini login` first" },
			{ kind: "response", id: 1, result: { authMethod: { id: "oauth", name: "Sign in" } }, error: undefined },
		]);
	});

	it("surfaces session/new results and prompt results", () => {
		const connection = new AcpConnection("gemini");
		const session = connection.newSessionMessage("H:/ws");
		const prompt = connection.promptMessage("s1", "hi");
		expect(connection.handleMessage({ jsonrpc: "2.0", id: session.id, result: { sessionId: "s1" } })).toEqual([
			{ kind: "session", sessionId: "s1" },
			{ kind: "response", id: session.id, result: { sessionId: "s1" }, error: undefined },
		]);
		expect(connection.handleMessage({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } })).toEqual([
			{ kind: "prompt-result", stopReason: "end_turn" },
		]);
		// the prompt id is consumed once — a replay falls back to a plain response
		expect(connection.handleMessage({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "cancelled" } })).toEqual([
			{ kind: "response", id: prompt.id, result: { stopReason: "cancelled" }, error: undefined },
		]);
		const retry = connection.promptMessage("s1", "again");
		expect(connection.handleMessage({ jsonrpc: "2.0", id: retry.id, error: { message: "boom" } })).toEqual([
			{ kind: "rpc-error", requestId: retry.id, message: "boom" },
		]);
	});

	it("maps session/update branches to emissions", () => {
		const connection = new AcpConnection("gemini");
		const update = (sessionUpdate: string, extra: Record<string, unknown>) => ({
			jsonrpc: "2.0",
			method: "session/update",
			params: { sessionId: "s1", update: { sessionUpdate, ...extra } },
		});
		expect(connection.handleMessage(update("agent_message_chunk", { content: { type: "text", text: "Hello" } })))
			.toEqual([{ kind: "emit", event: { type: "text-delta", text: "Hello" } }]);
		// content may be a block array
		expect(connection.handleMessage(update("agent_message_chunk", { content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] })))
			.toEqual([{ kind: "emit", event: { type: "text-delta", text: "AB" } }]);
		expect(connection.handleMessage(update("agent_thought_chunk", { content: { type: "text", text: "hmm" } })))
			.toEqual([{ kind: "emit", event: { type: "thinking-delta", text: "hmm" } }]);
		expect(connection.handleMessage(update("tool_call", { toolCallId: "t1", title: "Read file", kind: "read", rawInput: { path: "a.ts" } })))
			.toEqual([{ kind: "emit", event: { type: "tool-call-started", callId: "t1", name: "Read file", input: { path: "a.ts" } } }]);
		expect(connection.handleMessage(update("tool_call_update", { toolCallId: "t1", status: "completed", rawOutput: "done" })))
			.toEqual([{ kind: "emit", event: { type: "tool-call-completed", callId: "t1", name: "Read file", status: "completed", result: "done" } }]);
		expect(connection.handleMessage(update("tool_call_update", { toolCallId: "t1", status: "failed", rawOutput: { code: 2 } })))
			.toEqual([{ kind: "emit", event: { type: "tool-call-completed", callId: "t1", name: "Read file", status: "error", result: '{"code":2}' } }]);
		// pending and plan updates are ignored
		expect(connection.handleMessage(update("tool_call_update", { toolCallId: "t1", status: "pending" }))).toEqual([]);
		expect(connection.handleMessage(update("plan", { entries: [] }))).toEqual([]);
		expect(connection.handleMessage({ jsonrpc: "2.0", method: "other/notification", params: {} })).toEqual([]);
	});

	it("decodes agent→client requests and answers unknown methods with an error", () => {
		const connection = new AcpConnection("gemini");
		expect(connection.handleMessage({
			jsonrpc: "2.0", id: 7, method: "session/request_permission",
			params: {
				options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }],
				toolCall: { toolCallId: "t9", title: "Edit file", kind: "edit" },
				input: { path: "a.ts" },
			},
		})).toEqual([{
			kind: "permission", requestId: 7, toolName: "Edit file", input: { path: "a.ts" }, callId: "t9",
			options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }],
		}]);
		expect(connection.handleMessage({ jsonrpc: "2.0", id: 8, method: "fs/read_text_file", params: { path: "a.ts", sessionId: "s1" } }))
			.toEqual([{ kind: "read-file", requestId: 8, path: "a.ts" }]);
		expect(connection.handleMessage({ jsonrpc: "2.0", id: 9, method: "fs/write_text_file", params: { path: "a.ts", content: "x" } }))
			.toEqual([{ kind: "write-file", requestId: 9, path: "a.ts", content: "x" }]);
		expect(connection.handleMessage({ jsonrpc: "2.0", id: 10, method: "session/unknown", params: {} })).toEqual([
			{ kind: "respond", message: acpErrorResponse(10, "ACP method not supported by AiWorkHarness: session/unknown") },
		]);
	});

	it("maps approval outcomes onto the agent's permission options", () => {
		const options = [{ optionId: "allow-always", kind: "allow_always" }, { optionId: "allow", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }];
		expect(permissionResponse(7, options, true)).toEqual({ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: "allow-always" } } });
		expect(permissionResponse(7, options, false)).toEqual({ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: "no" } } });
		// no matching kind → fall back to the first option
		expect((permissionResponse(7, [{ optionId: "only", kind: "mystery" }], true) as any).result)
			.toEqual({ outcome: { outcome: "selected", optionId: "only" } });
		expect((permissionResponse(7, [], true) as any).result).toEqual({ outcome: { outcome: "selected", optionId: undefined } });
	});

	it("rejects workspace escapes for fs reads", () => {
		expect(isInsideWorkspace("H:/ws", "H:/ws/a.ts")).toBe(true);
		expect(isInsideWorkspace("H:/ws", "a.ts")).toBe(true);
		expect(isInsideWorkspace("H:/ws", "H:/ws")).toBe(true);
		expect(isInsideWorkspace("H:/ws", "H:/other/a.ts")).toBe(false);
		expect(isInsideWorkspace("H:/ws", "C:/Windows/system32/config")).toBe(false);
		expect(isInsideWorkspace("H:/ws", "")).toBe(false);
	});
});

describe("runAcpEngine", () => {
	it("handshakes, prompts and resolves on the prompt result", async () => {
		const child = fakeChild();
		const deps = depsFor(child);
		const { rt, emit } = runtime();
		const promise = runAcpEngine(rt, SPEC, deps);
		await flush();

		expect(deps.spawn).toHaveBeenCalledWith("C:/bin/gemini.exe", ["--experimental-acp"], "H:/ws");
		expect(writtenMessages(child)[0]).toEqual({
			jsonrpc: "2.0", id: 1, method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } },
		});

		sendLines(child, [{ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }]);
		await flush();
		expect(writtenMessages(child)[1]).toEqual({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "H:/ws", mcpServers: [] } });

		sendLines(child, [{ jsonrpc: "2.0", id: 2, result: { sessionId: "sess_1" } }]);
		await flush();
		expect(writtenMessages(child)[2]).toEqual({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "sess_1", prompt: [{ type: "text", text: "do the thing" }] } });

		sendLines(child, [
			{ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess_1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } } } },
			{ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess_1", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Shell", rawInput: { command: "ls" } } } },
			{ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess_1", update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "out" } } },
		]);
		sendLines(child, [{ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } }]);
		await expect(promise).resolves.toEqual({ text: "Hello", sessionId: "sess_1" });
		expect(eventTypes(emit)).toEqual(["text-delta", "tool-call-started", "tool-call-completed"]);
	});

	it("answers request_permission with the approved option id", async () => {
		const child = fakeChild();
		const { rt, approve } = runtime();
		const promise = runAcpEngine(rt, SPEC, depsFor(child));
		await flush();
		sendLines(child, [{ jsonrpc: "2.0", id: 1, result: {} }]);
		await flush();
		sendLines(child, [{ jsonrpc: "2.0", id: 2, result: { sessionId: "sess_1" } }]);
		await flush();
		sendLines(child, [
			{ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } },
			{
				jsonrpc: "2.0", id: 10, method: "session/request_permission",
				params: {
					options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }],
					toolCall: { toolCallId: "t1", title: "Shell" },
					input: { command: "ls" },
				},
			},
		]);
		await flush();

		expect(approve).toHaveBeenCalledWith("Shell", { command: "ls" }, "t1");
		const last = writtenMessages(child).at(-1);
		expect(last).toEqual({ jsonrpc: "2.0", id: 10, result: { outcome: { outcome: "selected", optionId: "allow" } } });
		await expect(promise).resolves.toBeTruthy();
	});

	it("denies fs writes that the user rejects and answers reads inside the workspace", async () => {
		const child = fakeChild();
		const { rt, approve } = runtime({ approve: async (toolName) => toolName !== "write" });
		const deps = depsFor(child);
		const promise = runAcpEngine(rt, SPEC, deps);
		await flush();
		sendLines(child, [{ jsonrpc: "2.0", id: 1, result: {} }]);
		await flush();
		sendLines(child, [{ jsonrpc: "2.0", id: 2, result: { sessionId: "sess_1" } }]);
		await flush();
		sendLines(child, [
			{ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } },
			{ jsonrpc: "2.0", id: 11, method: "fs/write_text_file", params: { path: "H:/ws/a.ts", content: "new" } },
			{ jsonrpc: "2.0", id: 12, method: "fs/read_text_file", params: { path: "H:/ws/a.ts" } },
			{ jsonrpc: "2.0", id: 13, method: "fs/read_text_file", params: { path: "H:/outside/secret.ts" } },
		]);
		await flush();

		expect(approve).toHaveBeenCalledWith("write", { path: "H:/ws/a.ts" }, undefined);
		// async responses may complete out of order — match them by request id
		const byId = (id: number) => writtenMessages(child).find((message) => message.id === id);
		expect(byId(11)).toEqual({ jsonrpc: "2.0", id: 11, error: { code: -32603, message: "Write denied by the user in AiWorkHarness" } });
		expect(byId(12)).toEqual({ jsonrpc: "2.0", id: 12, result: { content: "file body" } });
		expect(deps.writeTextFile).not.toHaveBeenCalled();
		// the in-workspace read went through once; the outside path never touched the fs
		expect(deps.readTextFile).toHaveBeenCalledTimes(1);
		expect(deps.readTextFile).toHaveBeenCalledWith("H:/ws/a.ts");
		expect(byId(13)).toEqual({ jsonrpc: "2.0", id: 13, error: { code: -32603, message: "Path is outside the workspace: H:/outside/secret.ts" } });
		await expect(promise).resolves.toBeTruthy();
	});

	it("answers unknown agent requests with an error response", async () => {
		const child = fakeChild();
		const { rt } = runtime();
		const promise = runAcpEngine(rt, SPEC, depsFor(child));
		await flush();
		sendLines(child, [{ jsonrpc: "2.0", id: 1, result: {} }]);
		await flush();
		sendLines(child, [{ jsonrpc: "2.0", id: 2, result: { sessionId: "sess_1" } }]);
		await flush();
		sendLines(child, [
			{ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } },
			{ jsonrpc: "2.0", id: 20, method: "webfetch", params: { url: "https://x" } },
		]);
		await flush();
		expect(writtenMessages(child).at(-1)).toEqual({
			jsonrpc: "2.0", id: 20, error: { code: -32603, message: "ACP method not supported by AiWorkHarness: webfetch" },
		});
		await expect(promise).resolves.toBeTruthy();
	});

	it("rejects with login guidance when the agent reports an auth method", async () => {
		const child = fakeChild();
		const { rt } = runtime();
		const promise = runAcpEngine(rt, SPEC, depsFor(child));
		await flush();
		sendLines(child, [{ jsonrpc: "2.0", id: 1, result: { authMethod: { id: "oauth-google", name: "Google" } } }]);
		await expect(promise).rejects.toThrow("Gemini CLI engine requires authentication: run `gemini login` first, then retry");
	});

	it("sends session/cancel and kills the process tree on abort", async () => {
		const child = fakeChild();
		const controller = new AbortController();
		const deps = depsFor(child);
		const { rt } = runtime({ signal: controller.signal });
		const promise = runAcpEngine(rt, SPEC, deps);
		await flush();
		sendLines(child, [{ jsonrpc: "2.0", id: 1, result: {} }]);
		await flush();
		sendLines(child, [{ jsonrpc: "2.0", id: 2, result: { sessionId: "sess_1" } }]);
		await flush();
		expect(writtenMessages(child).at(-1)?.method).toBe("session/prompt");

		controller.abort();
		await expect(promise).resolves.toEqual({ text: "", sessionId: "sess_1" });
		expect(writtenMessages(child).at(-1)).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "sess_1" } });
		expect(deps.killTree).toHaveBeenCalledWith(4242);
	});

	it("sends queued steering as a follow-up prompt after the current one ends", async () => {
		const child = fakeChild();
		const { rt, drainSteering } = runtime();
		const promise = runAcpEngine(rt, SPEC, depsFor(child));
		await flush();
		sendLines(child, [{ jsonrpc: "2.0", id: 1, result: {} }]);
		await flush();
		sendLines(child, [{ jsonrpc: "2.0", id: 2, result: { sessionId: "sess_1" } }]);
		await flush();

		drainSteering.mockResolvedValueOnce(["use tabs"]); // delivered once; later ticks are empty
		await new Promise<void>((resolve) => setTimeout(resolve, 550)); // steering arrives while the prompt is in flight
		// still waiting on the first prompt result → nothing sent yet
		expect(writtenMessages(child).filter((message) => message.method === "session/prompt")).toHaveLength(1);

		sendLines(child, [{ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } }]);
		await flush();
		const prompts = writtenMessages(child).filter((message) => message.method === "session/prompt");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toEqual({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: "sess_1", prompt: [{ type: "text", text: "use tabs" }] } });

		sendLines(child, [{ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } }]);
		await expect(promise).resolves.toEqual({ text: "", sessionId: "sess_1" });
	});

	it("rejects with the stderr tail when the process exits before a result", async () => {
		const child = fakeChild();
		const { rt, emit } = runtime();
		const promise = runAcpEngine(rt, SPEC, depsFor(child));
		await flush();
		child.stderr.emit("data", Buffer.from("bad flag: --experimental-acp"));
		child.emit("exit", 1);
		await expect(promise).rejects.toThrow("Gemini CLI engine exited (code 1) before a result: bad flag: --experimental-acp");
		expect(eventTypes(emit)).toEqual([]);
	});
});

function eventTypes(emit: ReturnType<typeof vi.fn>) {
	return emit.mock.calls.map((call) => (call[0] as AgentEvent).type);
}
