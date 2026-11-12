/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "../types";
import {
	anthropicMessageBody,
	collectNonStreaming,
	createAnthropicStreamEncoder,
	createOpenAIStreamEncoder,
	fromAnthropicMessagesRequest,
	fromOpenAIChatRequest,
	openAIChatCompletionBody,
	toAnthropicStopReason,
	toOpenAIStopReason,
} from "./translate";

function openAIChunks(frames: string[]): any[] {
	return frames.filter((frame) => frame.startsWith("data: ") && !frame.startsWith("data: [DONE]"))
		.map((frame) => JSON.parse(frame.slice("data: ".length).trim()));
}

function anthropicEvents(frames: string[]): { event: string; data: any }[] {
	return frames.map((frame) => {
		const [eventLine, dataLine] = frame.trim().split("\n");
		return { event: eventLine.replace(/^event: /, ""), data: JSON.parse(dataLine.replace(/^data: /, "")) };
	});
}

describe("OpenAI stream encoder", () => {
	it("emits a role chunk, text deltas, finish reason and [DONE]", () => {
		const encoder = createOpenAIStreamEncoder("test-model");
		const frames = [
			...encoder.push({ type: "text-delta", text: "Hello" }),
			...encoder.push({ type: "text-delta", text: " world" }),
			...encoder.push({ type: "done", finishReason: "stop" }),
			...encoder.end(),
		];
		const chunks = openAIChunks(frames);
		expect(chunks[0]).toMatchObject({ object: "chat.completion.chunk", model: "test-model", choices: [{ delta: { role: "assistant" } }] });
		expect(chunks[1].choices[0].delta).toEqual({ content: "Hello" });
		expect(chunks[2].choices[0].delta).toEqual({ content: " world" });
		expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
		expect(frames.at(-1)).toBe("data: [DONE]\n\n");
	});

	it("chunks tool-call deltas and does not duplicate the complete arguments", () => {
		const encoder = createOpenAIStreamEncoder("test-model");
		const call = { id: "call_1", name: "read_file", arguments: '{"path":"a"}' };
		const frames = [
			...encoder.push({ type: "tool-call-start", index: 0, id: call.id, name: call.name }),
			...encoder.push({ type: "tool-call-args-delta", index: 0, delta: '{"path"' }),
			...encoder.push({ type: "tool-call-args-delta", index: 0, delta: ':"a"}' }),
			...encoder.push({ type: "tool-call", call }),
			...encoder.push({ type: "done", finishReason: "tool_calls" }),
		];
		const deltas = openAIChunks(frames).filter((chunk) => chunk.choices[0].delta.tool_calls);
		expect(deltas[0].choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } });
		expect(deltas[1].choices[0].delta.tool_calls[0].function.arguments).toBe('{"path"');
		expect(deltas[2].choices[0].delta.tool_calls[0].function.arguments).toBe(':"a"}');
		// The completed tool-call event adds neither a third argument chunk nor a duplicate.
		expect(deltas).toHaveLength(3);
		expect(openAIChunks(frames).at(-1).choices[0].finish_reason).toBe("tool_calls");
	});
});

describe("Anthropic stream encoder", () => {
	it("emits the strict message/content_block/message_delta/message_stop sequence", () => {
		const encoder = createAnthropicStreamEncoder("claude-test");
		const events = anthropicEvents([
			...encoder.push({ type: "text-delta", text: "Hi" }),
			...encoder.push({ type: "text-delta", text: " there" }),
			...encoder.push({ type: "done", finishReason: "stop" }),
		]);
		expect(events.map((event) => event.event)).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		expect(events[0].data.message).toMatchObject({ type: "message", role: "assistant", model: "claude-test", content: [] });
		expect(events[0].data.message.usage.input_tokens).toBeTypeOf("number");
		expect(events[1].data.content_block).toEqual({ type: "text", text: "" });
		expect(events[2].data.delta).toEqual({ type: "text_delta", text: "Hi" });
		expect(events.at(-2)!.data.delta.stop_reason).toBe("end_turn");
	});

	it("streams a tool_use block with input_json_delta", () => {
		const encoder = createAnthropicStreamEncoder("claude-test");
		const call = { id: "toolu_1", name: "Read", arguments: '{"file":"a"}' };
		const events = anthropicEvents([
			...encoder.push({ type: "tool-call-start", index: 0, id: call.id, name: call.name }),
			...encoder.push({ type: "tool-call-args-delta", index: 0, delta: '{"file"' }),
			...encoder.push({ type: "tool-call-args-delta", index: 0, delta: ':"a"}' }),
			...encoder.push({ type: "tool-call", call }),
			...encoder.push({ type: "done", finishReason: "tool_calls" }),
		]);
		const start = events.find((event) => event.event === "content_block_start")!;
		expect(start.data.content_block).toEqual({ type: "tool_use", id: "toolu_1", name: "Read", input: {} });
		const deltas = events.filter((event) => event.event === "content_block_delta").map((event) => event.data.delta);
		expect(deltas).toEqual([
			{ type: "input_json_delta", partial_json: '{"file"' },
			{ type: "input_json_delta", partial_json: ':"a"}' },
		]);
		expect(events.at(-2)!.data.delta.stop_reason).toBe("tool_use");
	});

	it("opens a thinking block before thinking_delta content", () => {
		const encoder = createAnthropicStreamEncoder("claude-test");
		const events = anthropicEvents([
			...encoder.push({ type: "thinking-delta", text: "pondering" }),
			...encoder.push({ type: "text-delta", text: "answer" }),
			...encoder.push({ type: "done", finishReason: "end_turn" }),
		]);
		const start = events.find((event) => event.event === "content_block_start")!;
		expect(start.data.content_block).toEqual({ type: "thinking", thinking: "" });
		expect(events.some((event) => event.event === "content_block_delta" && event.data.delta.type === "thinking_delta")).toBe(true);
	});
});

describe("request parsing", () => {
	it("maps OpenAI messages, tool calls and tools", () => {
		const parsed = fromOpenAIChatRequest({
			model: "gpt-test",
			stream: true,
			temperature: 0,
			max_tokens: 128,
			stop: ["END"],
			messages: [
				{ role: "system", content: "be nice" },
				{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
				{ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] },
				{ role: "tool", tool_call_id: "call_1", content: "done" },
			],
			tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } }],
			tool_choice: "auto",
		});
		expect(parsed.model).toBe("gpt-test");
		expect(parsed.stream).toBe(true);
		expect(parsed.temperature).toBe(0);
		expect(parsed.maxTokens).toBe(128);
		expect(parsed.stopSequences).toEqual(["END"]);
		expect(parsed.messages[0]).toEqual({ role: "system", content: "be nice" });
		expect(parsed.messages[1].role).toBe("user");
		expect(parsed.messages[2]).toEqual({
			role: "assistant",
			content: null,
			tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
		});
		expect(parsed.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "done" });
		expect(parsed.tools).toEqual([{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } }]);
	});

	it("maps Anthropic system blocks, tool_use and tool_result blocks", () => {
		const parsed = fromAnthropicMessagesRequest({
			model: "claude-test",
			stream: true,
			max_tokens: 256,
			system: [{ type: "text", text: "rules" }],
			messages: [
				{ role: "user", content: "hello" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "checking" },
						{ type: "tool_use", id: "toolu_1", name: "Read", input: { file: "a" } },
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "contents" }] },
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
					],
				},
			],
			tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object" } }],
		});
		expect(parsed.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "rules" }] });
		expect(parsed.messages[1]).toEqual({ role: "user", content: "hello" });
		expect(parsed.messages[2]).toMatchObject({
			role: "assistant",
			content: "checking",
			tool_calls: [{ id: "toolu_1", type: "function", function: { name: "Read", arguments: '{"file":"a"}' } }],
		});
		expect(parsed.messages[3]).toEqual({ role: "tool", tool_call_id: "toolu_1", content: [{ type: "text", text: "contents" }] });
		expect(parsed.messages[4]).toEqual({ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] });
		expect(parsed.tools).toEqual([{ type: "function", function: { name: "Read", description: "Read a file", parameters: { type: "object" } } }]);
	});
});

describe("stop reasons", () => {
	it("maps in both directions", () => {
		expect(toAnthropicStopReason("stop")).toBe("end_turn");
		expect(toAnthropicStopReason("length")).toBe("max_tokens");
		expect(toAnthropicStopReason("tool_calls")).toBe("tool_use");
		expect(toOpenAIStopReason("end_turn")).toBe("stop");
		expect(toOpenAIStopReason("max_tokens")).toBe("length");
		expect(toOpenAIStopReason("tool_use")).toBe("tool_calls");
	});
});

describe("non-streaming aggregation", () => {
	const events: ProviderEvent[] = [
		{ type: "text-delta", text: "Hello " },
		{ type: "text-delta", text: "world" },
		{ type: "tool-call-start", index: 0, id: "call_1", name: "read_file" },
		{ type: "tool-call-args-delta", index: 0, delta: '{"path":' },
		{ type: "tool-call-args-delta", index: 0, delta: '"a"}' },
		{ type: "tool-call", call: { id: "call_1", name: "read_file", arguments: '{"path":"a"}' } },
		{ type: "usage", promptTokens: 5, completionTokens: 3 },
		{ type: "done", finishReason: "tool_calls" },
	];

	it("collects text, tools and usage", async () => {
		const aggregate = await collectNonStreaming(events);
		expect(aggregate.text).toBe("Hello world");
		expect(aggregate.toolCalls).toEqual([{ id: "call_1", name: "read_file", arguments: '{"path":"a"}' }]);
		expect(aggregate.usage).toEqual({ prompt_tokens: 5, completion_tokens: 3 });
		expect(aggregate.finishReason).toBe("tool_calls");
	});

	it("serializes OpenAI and Anthropic completion bodies", async () => {
		const aggregate = await collectNonStreaming(events);
		const openai = openAIChatCompletionBody("test-model", aggregate);
		expect(openai.object).toBe("chat.completion");
		expect(openai.choices[0]).toMatchObject({
			index: 0,
			message: {
				role: "assistant",
				content: "Hello world",
				tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
			},
			finish_reason: "tool_calls",
		});
		expect(openai.usage).toEqual({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });

		const anthropic = anthropicMessageBody("claude-test", aggregate);
		expect(anthropic).toMatchObject({
			type: "message",
			role: "assistant",
			model: "claude-test",
			stop_reason: "tool_use",
			usage: { input_tokens: 5, output_tokens: 3 },
			content: [
				{ type: "text", text: "Hello world" },
				{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a" } },
			],
		});
	});
});
