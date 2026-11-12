/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { handleOpenCodeEvent, parseSseFrames } from "./openCode";

describe("parseSseFrames", () => {
	it("extracts complete frames and keeps the trailing partial", () => {
		const buffer = [
			'data: {"type":"session.status"}',
			"",
			'data: {"type":"session.error"}',
			"",
			"data: {\"type\":\"mess", // partial frame, no terminator yet
		].join("\n");
		const { events, rest } = parseSseFrames(buffer);
		expect(events).toEqual([{ type: "session.status" }, { type: "session.error" }]);
		expect(rest).toBe("data: {\"type\":\"mess");
	});

	it("joins multi-line data payloads and skips malformed JSON", () => {
		const buffer = 'data: {\ndata: "type":"a"\ndata: }\n\ndata: not-json\n\n';
		const { events, rest } = parseSseFrames(buffer);
		expect(events).toEqual([{ type: "a" }]);
		expect(rest).toBe("");
	});
});

describe("handleOpenCodeEvent", () => {
	const frame = (type: string, properties: Record<string, unknown>) => ({ type, properties });

	it("maps text and thinking part deltas", () => {
		expect(handleOpenCodeEvent(frame("message.part.delta", { sessionID: "s1", part: { type: "text" }, delta: { text: "Hi" } }), "s1"))
			.toEqual([{ kind: "emit", event: { type: "text-delta", text: "Hi" } }]);
		expect(handleOpenCodeEvent(frame("message.part.delta", { sessionID: "s1", part: "thinking", delta: "hmm" }), "s1"))
			.toEqual([{ kind: "emit", event: { type: "thinking-delta", text: "hmm" } }]);
		// Deltas from other sessions are dropped.
		expect(handleOpenCodeEvent(frame("message.part.delta", { sessionID: "s2", part: { type: "text" }, delta: { text: "Hi" } }), "s1"))
			.toEqual([]);
		// Empty deltas produce nothing.
		expect(handleOpenCodeEvent(frame("message.part.delta", { sessionID: "s1", part: { type: "text" }, delta: { text: "" } }), "s1"))
			.toEqual([]);
	});

	it("maps session status to completion and retries", () => {
		expect(handleOpenCodeEvent(frame("session.status", { sessionID: "s1", status: { type: "idle" } }), "s1"))
			.toEqual([{ kind: "completed" }]);
		expect(handleOpenCodeEvent(frame("session.status", { sessionID: "s1", status: "idle" }), "s1"))
			.toEqual([{ kind: "completed" }]);
		expect(handleOpenCodeEvent(frame("session.status", { sessionID: "s1", status: { type: "retry", attempt: 3 } }), "s1"))
			.toEqual([{ kind: "retry", attempt: 3, error: "server retry" }]);
		// "busy" and other states are ignored.
		expect(handleOpenCodeEvent(frame("session.status", { sessionID: "s1", status: { type: "busy" } }), "s1"))
			.toEqual([]);
	});

	it("maps session errors with their message", () => {
		expect(handleOpenCodeEvent(frame("session.error", { sessionID: "s1", error: { message: "overloaded" } }), "s1"))
			.toEqual([{ kind: "error", message: "overloaded" }]);
		expect(handleOpenCodeEvent(frame("session.error", { sessionID: "s1", error: "boom" }), "s1"))
			.toEqual([{ kind: "error", message: "boom" }]);
	});

	it("maps permission asks and ignores questions", () => {
		expect(handleOpenCodeEvent(frame("permission.asked", { sessionID: "s1", id: "perm_1", permission: "bash", metadata: { command: "rm -rf" } }), "s1"))
			.toEqual([{ kind: "permission", requestId: "perm_1", toolName: "bash", input: { command: "rm -rf" }, callId: undefined }]);
		expect(handleOpenCodeEvent(frame("permission.asked", { sessionID: "s1", id: "perm_2", type: "edit", callID: "call_1", title: "src/a.ts" }), "s1"))
			.toEqual([{ kind: "permission", requestId: "perm_2", toolName: "edit", input: "src/a.ts", callId: "call_1" }]);
		expect(handleOpenCodeEvent(frame("permission.asked", { sessionID: "s1", id: "perm_3" }), "s1"))
			.toEqual([{ kind: "permission", requestId: "perm_3", toolName: "opencode", input: {}, callId: undefined }]);
		expect(handleOpenCodeEvent(frame("permission.asked", { sessionID: "s1" }), "s1"))
			.toEqual([]);
		expect(handleOpenCodeEvent(frame("question.asked", { sessionID: "s1", id: "q_1" }), "s1"))
			.toEqual([]);
		// Unknown event types produce nothing.
		expect(handleOpenCodeEvent(frame("message.updated", { sessionID: "s1" }), "s1"))
			.toEqual([]);
	});
});
