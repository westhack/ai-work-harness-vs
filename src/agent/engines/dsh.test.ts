/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { buildPromptRequest, buildRpcEnvelope, DshFrameParser, extractLaunchToken, parseRpcResult } from "./dsh";
import type { DshAction } from "./dsh";

/**
 * Every wire shape below is copied from the verified reference client
 * (desktop-cc-gui-main/src-tauri/src/engine/dsh_session.rs and dsh_host.rs):
 * mux frames are `{type:"item",streamId,value}`, follow values carry
 * `{type:"event",event:{type,data}}` / `{type:"assistant-stream",frame}` and
 * events values carry `{type:"ready"|"waterfall"}`.
 */

const followFrame = (value: unknown) => JSON.stringify({ type: "item", streamId: "follow", value });
const eventsFrame = (value: unknown) => JSON.stringify({ type: "item", streamId: "events", value });

describe("extractLaunchToken", () => {
	// Cases ported from dsh_host.rs's own unit tests.
	it("extracts the token from the dsh web launch line", () => {
		expect(extractLaunchToken("dsh web: http://127.0.0.1:3080/?token=RmF6KLIdrmQlbogo4A_StSQsyzSCzn79Et8S0CVjpUE"))
			.toBe("RmF6KLIdrmQlbogo4A_StSQsyzSCzn79Et8S0CVjpUE");
	});

	it("requires a query prefix and stops at the delimiter", () => {
		expect(extractLaunchToken("no token here")).toBeUndefined();
		expect(extractLaunchToken("dsh web: http://127.0.0.1:3080/token=x")).toBeUndefined();
		expect(extractLaunchToken("GET /?token=abc-DEF_123 trailing")).toBe("abc-DEF_123");
	});
});

describe("buildRpcEnvelope / parseRpcResult", () => {
	it("wraps args in the client-request envelope", () => {
		const envelope = JSON.parse(buildRpcEnvelope("session/prompt", { request: { a: 1 } })) as any;
		expect(envelope.type).toBe("client-request");
		expect(typeof envelope.rpcId).toBe("string");
		expect(envelope.method).toBe("session/prompt");
		expect(envelope.payload).toEqual({ args: { request: { a: 1 } } });
	});

	it("decodes ok results and structured errors", () => {
		expect(parseRpcResult(JSON.stringify({ type: "server-response", rpcId: "r", result: { ok: true, value: { sessionId: "s1" } } })))
			.toEqual({ ok: true, value: { sessionId: "s1" } });
		expect(parseRpcResult(JSON.stringify({ type: "server-response", rpcId: "r", result: { ok: false, error: { code: "x", message: "nope" } } })))
			.toEqual({ ok: false, error: "nope" });
	});

	it("rejects non-JSON bodies and non-envelope types", () => {
		expect(parseRpcResult("not json").ok).toBe(false);
		expect(parseRpcResult(JSON.stringify({ type: "something-else" })).ok).toBe(false);
	});
});

describe("buildPromptRequest", () => {
	it("matches the session/prompt wire shape (mode queue, content parts)", () => {
		const request = buildPromptRequest("session-1", "hi there") as any;
		expect(request.request.sessionId).toBe("session-1");
		expect(request.request.mode).toBe("queue");
		expect(request.request.content).toEqual([{ type: "text", text: "hi there" }]);
		expect(typeof request.request.requestId).toBe("string");
		expect(typeof request.request.clientTimeZone).toBe("string");
	});
});

describe("DshFrameParser — assistant-stream chunks", () => {
	it("maps text and reasoning deltas", () => {
		const parser = new DshFrameParser();
		expect(parser.handleFrame(followFrame({ type: "assistant-stream", frame: { type: "start" } }))).toEqual([]);
		expect(parser.handleFrame(followFrame({ type: "assistant-stream", frame: { type: "chunk", chunk: { type: "text-delta", text: "1+1" } } })))
			.toEqual([{ kind: "emit", event: { type: "text-delta", text: "1+1" } }]);
		expect(parser.handleFrame(followFrame({ type: "assistant-stream", frame: { type: "chunk", chunk: { type: "reasoning-delta", text: "思考" } } })))
			.toEqual([{ kind: "emit", event: { type: "thinking-delta", text: "思考" } }]);
		// Empty deltas produce nothing.
		expect(parser.handleFrame(followFrame({ type: "assistant-stream", frame: { type: "chunk", chunk: { type: "text-delta", text: "" } } }))).toEqual([]);
	});

	it("maps usage chunks onto usage events", () => {
		const parser = new DshFrameParser();
		const actions = parser.handleFrame(followFrame({
			type: "assistant-stream",
			frame: { type: "chunk", chunk: { type: "usage", usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 } } },
		}));
		expect(actions).toEqual([{ kind: "emit", event: {
			type: "usage",
			promptTokens: 100,
			completionTokens: 20,
			totalTokens: 120,
			source: "parent",
			cachedReadTokens: 50,
			cachedWriteTokens: 5,
		} }]);
	});

	it("skips block-start / block-end / finish chunks", () => {
		const parser = new DshFrameParser();
		expect(parser.handleFrame(followFrame({ type: "assistant-stream", frame: { type: "chunk", chunk: { type: "block-start" } } }))).toEqual([]);
		expect(parser.handleFrame(followFrame({ type: "assistant-stream", frame: { type: "end" } }))).toEqual([]);
	});
});

describe("DshFrameParser — durable session events", () => {
	it("maps tool/call rows onto tool-call-started with parsed arguments", () => {
		const parser = new DshFrameParser();
		const actions = parser.handleFrame(followFrame({
			type: "event",
			event: { type: "tool/call", data: { name: "bash", callId: "call-1", arguments: JSON.stringify({ command: "echo hi" }) } },
		}));
		expect(actions).toEqual([{ kind: "emit", event: {
			type: "tool-call-started",
			callId: "call-1",
			name: "bash",
			input: { command: "echo hi" },
		} }]);
	});

	it("maps tool/result patches onto tool-call-completed with the tracked name", () => {
		const parser = new DshFrameParser();
		parser.handleFrame(followFrame({
			type: "event",
			event: { type: "tool/call", data: { name: "bash", callId: "call-1", arguments: "{}" } },
		}));
		const actions = parser.handleFrame(followFrame({
			type: "event",
			event: { type: "tool/result", data: { message: { source: { callId: "call-1" }, content: [{ text: "hi\n" }] } } },
		}));
		expect(actions).toEqual([{ kind: "emit", event: {
			type: "tool-call-completed",
			callId: "call-1",
			name: "bash",
			status: "completed",
			result: "hi\n",
		} }]);

		const errorActions = parser.handleFrame(followFrame({
			type: "event",
			event: { type: "tool/result", data: { message: { source: { callId: "call-2" }, content: [{ text: "boom", isError: true }] } } },
		}));
		expect((errorActions[0] as Extract<DshAction, { kind: "emit" }>).event).toMatchObject({
			type: "tool-call-completed",
			callId: "call-2",
			status: "error",
			result: "boom",
		});
	});

	it("falls back to the whole durable assistant/message when no deltas streamed", () => {
		const parser = new DshFrameParser();
		const actions = parser.handleFrame(followFrame({
			type: "event",
			event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "完整回复" }] } } },
		}));
		expect(actions).toEqual([{ kind: "emit", event: { type: "text-delta", text: "完整回复\n\n" } }]);
	});

	it("suppresses the durable assistant/message after live deltas (no double render)", () => {
		const parser = new DshFrameParser();
		parser.handleFrame(followFrame({ type: "assistant-stream", frame: { type: "start" } }));
		parser.handleFrame(followFrame({ type: "assistant-stream", frame: { type: "chunk", chunk: { type: "text-delta", text: "流式" } } }));
		const actions = parser.handleFrame(followFrame({
			type: "event",
			event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "流式" }] } } },
		}));
		expect(actions).toEqual([]);
		// The next attempt starts clean: a durable message renders again.
		const next = parser.handleFrame(followFrame({
			type: "event",
			event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "第二轮" }] } } },
		}));
		expect(next).toEqual([{ kind: "emit", event: { type: "text-delta", text: "第二轮\n\n" } }]);
	});

	it("settles the turn on turn/end and ignores snapshot and noise events", () => {
		const parser = new DshFrameParser();
		expect(parser.handleFrame(followFrame({ type: "snapshot" }))).toEqual([]);
		expect(parser.handleFrame(followFrame({ type: "event", event: { type: "plan/mode", data: {} } }))).toEqual([]);
		expect(parser.handleFrame(followFrame({ type: "event", event: { type: "turn/end", data: { reason: { kind: "completed" } } } })))
			.toEqual([{ kind: "turn-ended", reason: "completed" }]);
		expect(parser.handleFrame(followFrame({ type: "event", event: { type: "turn/end", data: { reason: { kind: "cancelled" } } } })))
			.toEqual([{ kind: "turn-ended", reason: "cancelled" }]);
	});
});

describe("DshFrameParser — $events frames", () => {
	it("captures the ready clientId", () => {
		const parser = new DshFrameParser();
		expect(parser.handleFrame(eventsFrame({ type: "ready", clientId: "client-9" })))
			.toEqual([{ kind: "events-client", clientId: "client-9" }]);
	});

	it("routes approval/request waterfalls to the approval UI", () => {
		const parser = new DshFrameParser();
		const actions = parser.handleFrame(eventsFrame({
			type: "waterfall",
			eventId: "wf-1",
			event: "approval/request",
			request: { tool: "bash", input: { command: "rm -rf" } },
		}));
		expect(actions).toEqual([{ kind: "approval", eventId: "wf-1", toolName: "bash", input: { tool: "bash", input: { command: "rm -rf" } } }]);
	});

	it("dismisses questions and unrecognized waterfalls (no question card yet)", () => {
		const parser = new DshFrameParser();
		expect(parser.handleFrame(eventsFrame({ type: "waterfall", eventId: "q-1", event: "user-questions/request" })))
			.toEqual([{ kind: "dismiss", eventId: "q-1" }]);
		expect(parser.handleFrame(eventsFrame({ type: "waterfall", eventId: "u-1", event: "something/else" })))
			.toEqual([{ kind: "dismiss", eventId: "u-1" }]);
		expect(parser.handleFrame(eventsFrame({ type: "cancel", eventId: "q-1" }))).toEqual([]);
	});
});

describe("DshFrameParser — malformed input", () => {
	it("ignores non-item frames and broken JSON", () => {
		const parser = new DshFrameParser();
		expect(parser.handleFrame("{not json")).toEqual([]);
		expect(parser.handleFrame(JSON.stringify({ type: "hello" }))).toEqual([]);
		expect(parser.handleFrame(JSON.stringify({ type: "item", streamId: "other", value: { type: "event" } }))).toEqual([]);
	});
});
