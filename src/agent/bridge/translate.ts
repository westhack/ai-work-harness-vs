/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { ProviderEvent, ToolCall, ToolSchema, WireContentPart, WireMessage, WireToolCall } from "../types";

/** Normalized request shared by both wire protocols. */
export interface BridgeChatRequest {
	messages: WireMessage[];
	tools?: ToolSchema[];
	temperature?: number;
	maxTokens?: number;
	stopSequences?: string[];
	stream: boolean;
	model: string;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function dataUrl(mime: string | undefined, data: string): string {
	return `data:${mime || "image/png"};base64,${data}`;
}

function openAIImagePart(url: string): WireContentPart {
	return { type: "image_url", image_url: { url } };
}

/** OpenAI `content` (string | parts) → WireMessage content parts. */
function openAIContent(content: unknown): string | WireContentPart[] {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: WireContentPart[] = [];
	for (const raw of content) {
		const part = asRecord(raw);
		if (part.type === "text" && typeof part.text === "string") {
			parts.push({ type: "text", text: part.text });
		} else if (part.type === "image_url") {
			const image = asRecord(part.image_url);
			const url = asString(image.url) ?? asString(part.image_url);
			if (url) parts.push(openAIImagePart(url));
		} else if (part.type === "input_text" && typeof part.text === "string") {
			parts.push({ type: "text", text: part.text });
		}
	}
	return parts;
}

function openAIAssistantContent(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	let text = "";
	for (const raw of content) {
		const part = asRecord(raw);
		if ((part.type === "text" || part.type === "output_text") && typeof part.text === "string") text += part.text;
	}
	return text || null;
}

function openAIToolCall(raw: unknown): WireToolCall | undefined {
	const call = asRecord(raw);
	const fn = asRecord(call.function);
	const name = asString(fn.name);
	if (!name) return;
	const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
	return { id: asString(call.id) ?? `call_${randomUUID()}`, type: "function", function: { name, arguments: args } };
}

/** OpenAI Chat Completions request → normalized wire request. Unknown fields are ignored. */
export function fromOpenAIChatRequest(body: unknown): BridgeChatRequest {
	const root = asRecord(body);
	const messages: WireMessage[] = [];
	for (const raw of Array.isArray(root.messages) ? root.messages : []) {
		const message = asRecord(raw);
		const role = asString(message.role);
		if (role === "system" || role === "developer") {
			messages.push({ role: "system", content: openAIContent(message.content) });
		} else if (role === "user") {
			messages.push({ role: "user", content: openAIContent(message.content) });
		} else if (role === "assistant") {
			const content = openAIAssistantContent(message.content);
			const toolCalls = Array.isArray(message.tool_calls)
				? message.tool_calls.map(openAIToolCall).filter((call): call is WireToolCall => !!call)
				: undefined;
			messages.push({ role: "assistant", content, ...(toolCalls?.length ? { tool_calls: toolCalls } : {}) });
		} else if (role === "tool") {
			messages.push({ role: "tool", tool_call_id: asString(message.tool_call_id) ?? "", content: openAIContent(message.content) });
		}
	}

	const tools: ToolSchema[] = [];
	for (const raw of Array.isArray(root.tools) ? root.tools : []) {
		const tool = asRecord(raw);
		const fn = asRecord(tool.function);
		const name = asString(fn.name);
		if (!name) continue;
		tools.push({
			type: "function",
			function: {
				name,
				description: asString(fn.description) ?? "",
				parameters: asRecord(fn.parameters),
			},
		});
	}

	const stop = root.stop;
	const stopSequences = typeof stop === "string" ? [stop] : Array.isArray(stop) ? stop.filter((s): s is string => typeof s === "string") : undefined;

	return {
		messages,
		...(tools.length ? { tools } : {}),
		temperature: finiteNumber(root.temperature),
		maxTokens: positiveNumber(root.max_tokens) ?? positiveNumber(root.max_completion_tokens),
		...(stopSequences?.length ? { stopSequences } : {}),
		stream: root.stream === true,
		model: asString(root.model) ?? "",
	};
}

function anthropicImagePart(block: Record<string, unknown>): WireContentPart | undefined {
	const source = asRecord(block.source);
	if (source.type === "base64") {
		const data = asString(source.data);
		if (!data) return;
		return openAIImagePart(dataUrl(asString(source.media_type), data));
	}
	if (source.type === "url") {
		const url = asString(source.url);
		if (url) return openAIImagePart(url);
	}
	return;
}

/** Anthropic tool_result content (string | text/image blocks) → WireMessage content. */
function anthropicToolResultContent(content: unknown): string | WireContentPart[] {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: WireContentPart[] = [];
	for (const raw of content) {
		const block = asRecord(raw);
		if (block.type === "text" && typeof block.text === "string") {
			parts.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			const part = anthropicImagePart(block);
			if (part) parts.push(part);
		}
	}
	return parts;
}

/** Anthropic Messages request → normalized wire request. Unknown fields are ignored. */
export function fromAnthropicMessagesRequest(body: unknown): BridgeChatRequest {
	const root = asRecord(body);

	let system: string | WireContentPart[] = "";
	if (typeof root.system === "string") {
		system = root.system;
	} else if (Array.isArray(root.system)) {
		const parts: WireContentPart[] = [];
		for (const raw of root.system) {
			const block = asRecord(raw);
			if (block.type === "text" && typeof block.text === "string") parts.push({ type: "text", text: block.text });
		}
		system = parts;
	}

	const messages: WireMessage[] = [];
	if (system.length > 0) {
		messages.push({ role: "system", content: system });
	}

	for (const raw of Array.isArray(root.messages) ? root.messages : []) {
		const message = asRecord(raw);
		const role = asString(message.role);
		const content = message.content;
		if (role === "assistant") {
			if (typeof content === "string") {
				messages.push({ role: "assistant", content });
				continue;
			}
			let text = "";
			const toolCalls: WireToolCall[] = [];
			for (const rawBlock of Array.isArray(content) ? content : []) {
				const block = asRecord(rawBlock);
				if (block.type === "text" && typeof block.text === "string") {
					text += block.text;
				} else if (block.type === "tool_use") {
					const name = asString(block.name);
					if (!name) continue;
					toolCalls.push({
						id: asString(block.id) ?? `call_${randomUUID()}`,
						type: "function",
						function: { name, arguments: JSON.stringify(block.input ?? {}) },
					});
				}
			}
			messages.push({
				role: "assistant",
				content: text || null,
				...(toolCalls.length ? { tool_calls: toolCalls } : {}),
			});
		} else if (role === "user") {
			if (typeof content === "string") {
				messages.push({ role: "user", content });
				continue;
			}
			const parts: WireContentPart[] = [];
			const toolResults: WireMessage[] = [];
			for (const rawBlock of Array.isArray(content) ? content : []) {
				const block = asRecord(rawBlock);
				if (block.type === "text" && typeof block.text === "string") {
					parts.push({ type: "text", text: block.text });
				} else if (block.type === "image") {
					const part = anthropicImagePart(block);
					if (part) parts.push(part);
				} else if (block.type === "tool_result") {
					toolResults.push({
						role: "tool",
						tool_call_id: asString(block.tool_use_id) ?? "",
						content: anthropicToolResultContent(block.content),
					});
				}
			}
			messages.push(...toolResults);
			if (parts.length) messages.push({ role: "user", content: parts });
		}
	}

	const tools: ToolSchema[] = [];
	for (const raw of Array.isArray(root.tools) ? root.tools : []) {
		const tool = asRecord(raw);
		const name = asString(tool.name);
		if (!name) continue;
		tools.push({
			type: "function",
			function: {
				name,
				description: asString(tool.description) ?? "",
				parameters: asRecord(tool.input_schema),
			},
		});
	}

	const stopSequences = Array.isArray(root.stop_sequences)
		? root.stop_sequences.filter((s): s is string => typeof s === "string")
		: undefined;

	return {
		messages,
		...(tools.length ? { tools } : {}),
		temperature: finiteNumber(root.temperature),
		maxTokens: positiveNumber(root.max_tokens),
		...(stopSequences?.length ? { stopSequences } : {}),
		stream: root.stream === true,
		model: asString(root.model) ?? "",
	};
}

// ---- Stop reason mapping ----

export function toAnthropicStopReason(reason: string | undefined): string {
	switch (reason) {
		case "tool_calls":
		case "tool_use":
			return "tool_use";
		case "length":
		case "max_tokens":
			return "max_tokens";
		case "stop":
		case "end_turn":
			return "end_turn";
		default:
			return "end_turn";
	}
}

export function toOpenAIStopReason(reason: string | undefined): string {
	switch (reason) {
		case "tool_use":
		case "tool_calls":
			return "tool_calls";
		case "max_tokens":
		case "length":
			return "length";
		default:
			return "stop";
	}
}

// ---- Error bodies ----

export function openAIErrorBody(message: string, type = "invalid_request_error", code: string | null = null) {
	return { error: { message, type, code } };
}

export function anthropicErrorBody(type: string, message: string) {
	return { type: "error", error: { type, message } };
}

// ---- OpenAI streaming encoder ----

interface OpenAIToolState {
	id: string;
	name: string;
	started: boolean;
	args: string;
	completed: boolean;
}

function openAIChunk(id: string, created: number, model: string, delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, unknown>): string {
	const payload: Record<string, unknown> = {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	if (usage) payload.usage = usage;
	return `data: ${JSON.stringify(payload)}\n\n`;
}

export interface OpenAIStreamEncoder {
	push(event: ProviderEvent): string[];
	end(): string[];
}

export function createOpenAIStreamEncoder(model: string): OpenAIStreamEncoder {
	const id = `chatcmpl-${randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);
	const tools = new Map<number, OpenAIToolState>();
	const toolIndexById = new Map<string, number>();
	let roleSent = false;
	let ended = false;
	let finishReason = "stop";
	let usage: { prompt_tokens: number; completion_tokens: number } | undefined;

	const chunks: string[] = [];
	const ensureRole = () => {
		if (roleSent) return;
		roleSent = true;
		chunks.push(openAIChunk(id, created, model, { role: "assistant" }, null));
	};
	const entryAt = (index: number): OpenAIToolState => {
		let entry = tools.get(index);
		if (!entry) {
			entry = { id: "", name: "", started: false, args: "", completed: false };
			tools.set(index, entry);
		}
		return entry;
	};

	return {
		push(event: ProviderEvent): string[] {
			chunks.length = 0;
			if (ended) return chunks;
			switch (event.type) {
				case "text-delta":
					if (!event.text) break;
					ensureRole();
					chunks.push(openAIChunk(id, created, model, { content: event.text }, null));
					break;
				case "tool-call-start": {
					ensureRole();
					const entry = entryAt(event.index);
					entry.id = event.id || entry.id;
					entry.name = event.name || entry.name;
					entry.started = true;
					if (entry.id) toolIndexById.set(entry.id, event.index);
					chunks.push(openAIChunk(id, created, model, {
						tool_calls: [{ index: event.index, id: entry.id, type: "function", function: { name: event.name, arguments: "" } }],
					}, null));
					break;
				}
				case "tool-call-args-delta": {
					ensureRole();
					const entry = entryAt(event.index);
					entry.args += event.delta;
					chunks.push(openAIChunk(id, created, model, {
						tool_calls: [{ index: event.index, function: { arguments: event.delta } }],
					}, null));
					break;
				}
				case "tool-call": {
					ensureRole();
					let index = toolIndexById.get(event.call.id);
					if (index === undefined) {
						for (const [candidate, entry] of tools) {
							if (!entry.completed && (!entry.id || entry.id === event.call.id || entry.name === event.call.name)) {
								index = candidate;
								break;
							}
						}
					}
					if (index === undefined) {
						index = tools.size;
						const entry = entryAt(index);
						entry.id = event.call.id;
						entry.name = event.call.name;
						entry.args = event.call.arguments;
						entry.started = true;
						entry.completed = true;
						tools.set(index, entry);
						toolIndexById.set(entry.id, index);
						chunks.push(openAIChunk(id, created, model, {
							tool_calls: [{ index, id: entry.id, type: "function", function: { name: entry.name, arguments: entry.args } }],
						}, null));
						break;
					}
					const entry = entryAt(index);
					// Accumulated argument deltas are authoritative; the complete call
					// only fills in identity/arguments the deltas did not provide.
					const delta: Record<string, unknown> = { index };
					const fnDelta: Record<string, unknown> = {};
					if (!entry.id) {
						entry.id = event.call.id;
						toolIndexById.set(entry.id, index);
						delta.id = entry.id;
						delta.type = "function";
					}
					if (!entry.name) {
						entry.name = event.call.name;
						fnDelta.name = entry.name;
					}
					if (!entry.started) {
						entry.started = true;
						delta.id = entry.id || event.call.id;
						delta.type = "function";
						if (!entry.args) {
							entry.args = event.call.arguments;
							fnDelta.arguments = entry.args;
						}
					}
					entry.completed = true;
					if (Object.keys(fnDelta).length) delta.function = fnDelta;
					if (Object.keys(delta).length > 1) {
						chunks.push(openAIChunk(id, created, model, { tool_calls: [delta] }, null));
					}
					break;
				}
				case "usage":
					usage = {
						prompt_tokens: event.promptTokensTotal ?? event.promptTokens ?? 0,
						completion_tokens: event.completionTokensTotal ?? event.completionTokens ?? 0,
					};
					break;
				case "done":
					finishReason = event.finishReason;
					chunks.push(...finish());
					break;
				case "thinking-delta":
				case "responses-reasoning":
				case "chat-reasoning":
					break;
			}
			return chunks;
		},
		end(): string[] {
			chunks.length = 0;
			if (!ended) chunks.push(...finish());
			return chunks;
		},
	};

	function finish(): string[] {
		ended = true;
		ensureRole();
		const out = [...chunks];
		const total = usage ? usage.prompt_tokens + usage.completion_tokens : 0;
		out.push(openAIChunk(id, created, model, {}, toOpenAIStopReason(finishReason),
			usage ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: total } : undefined));
		out.push("data: [DONE]\n\n");
		chunks.length = 0;
		return out;
	}
}

// ---- Anthropic streaming encoder ----

interface AnthropicTextBlock {
	kind: "text" | "thinking";
	index: number;
}
interface AnthropicToolBlock {
	index: number;
	id: string;
	name: string;
	args: string;
	started: boolean;
}

function anthropicEvent(type: string, data: Record<string, unknown>): string {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export interface AnthropicStreamEncoder {
	push(event: ProviderEvent): string[];
	end(): string[];
}

export function createAnthropicStreamEncoder(model: string): AnthropicStreamEncoder {
	const id = `msg_${randomBytes(12).toString("hex")}`;
	let started = false;
	let ended = false;
	let nextIndex = 0;
	let textBlock: AnthropicTextBlock | undefined;
	let thinkingBlock: AnthropicTextBlock | undefined;
	const toolBlocks = new Map<number, AnthropicToolBlock>();
	const toolIndexById = new Map<string, number>();
	let inputTokens = 0;
	let outputTokens = 0;
	let stopReason = "end_turn";
	const chunks: string[] = [];

	const ensureStarted = () => {
		if (started) return;
		started = true;
		chunks.push(anthropicEvent("message_start", {
			message: {
				id,
				type: "message",
				role: "assistant",
				model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: inputTokens, output_tokens: 0 },
			},
		}));
	};
	const stopBlock = (block: AnthropicTextBlock | AnthropicToolBlock | undefined) => {
		if (!block) return;
		chunks.push(anthropicEvent("content_block_stop", { index: block.index }));
	};
	const stopTextBlocks = () => {
		if (thinkingBlock) { stopBlock(thinkingBlock); thinkingBlock = undefined; }
		if (textBlock) { stopBlock(textBlock); textBlock = undefined; }
	};
	const openToolBlock = (toolIndex: number, callId: string, name: string): AnthropicToolBlock => {
		let block = toolBlocks.get(toolIndex);
		if (block) return block;
		block = { index: nextIndex++, id: callId || `call_${toolIndex}`, name, args: "", started: true };
		toolBlocks.set(toolIndex, block);
		if (block.id) toolIndexById.set(block.id, toolIndex);
		chunks.push(anthropicEvent("content_block_start", {
			index: block.index,
			content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
		}));
		return block;
	};

	return {
		push(event: ProviderEvent): string[] {
			chunks.length = 0;
			if (ended) return chunks;
			switch (event.type) {
				case "text-delta": {
					if (!event.text) break;
					ensureStarted();
					if (thinkingBlock) { stopBlock(thinkingBlock); thinkingBlock = undefined; }
					if (!textBlock) {
						textBlock = { kind: "text", index: nextIndex++ };
						chunks.push(anthropicEvent("content_block_start", {
							index: textBlock.index,
							content_block: { type: "text", text: "" },
						}));
					}
					chunks.push(anthropicEvent("content_block_delta", {
						index: textBlock.index,
						delta: { type: "text_delta", text: event.text },
					}));
					break;
				}
				case "thinking-delta": {
					if (!event.text) break;
					ensureStarted();
					if (!thinkingBlock) {
						thinkingBlock = { kind: "thinking", index: nextIndex++ };
						chunks.push(anthropicEvent("content_block_start", {
							index: thinkingBlock.index,
							content_block: { type: "thinking", thinking: "" },
						}));
					}
					chunks.push(anthropicEvent("content_block_delta", {
						index: thinkingBlock.index,
						delta: { type: "thinking_delta", thinking: event.text },
					}));
					break;
				}
				case "tool-call-start": {
					ensureStarted();
					stopTextBlocks();
					openToolBlock(event.index, event.id, event.name);
					break;
				}
				case "tool-call-args-delta": {
					ensureStarted();
					let block = toolBlocks.get(event.index);
					if (!block) block = openToolBlock(event.index, "", "");
					block.args += event.delta;
					chunks.push(anthropicEvent("content_block_delta", {
						index: block.index,
						delta: { type: "input_json_delta", partial_json: event.delta },
					}));
					break;
				}
				case "tool-call": {
					ensureStarted();
					stopTextBlocks();
					let toolIndex = toolIndexById.get(event.call.id);
					if (toolIndex === undefined) {
						for (const [candidate, block] of toolBlocks) {
							if (!block.name || block.id === event.call.id) { toolIndex = candidate; break; }
						}
					}
					if (toolIndex === undefined) {
						// A complete call with no streamed start: emit a full block.
						toolIndex = toolBlocks.size;
						const block = openToolBlock(toolIndex, event.call.id, event.call.name);
						block.args = event.call.arguments;
						chunks.push(anthropicEvent("content_block_delta", {
							index: block.index,
							delta: { type: "input_json_delta", partial_json: event.call.arguments },
						}));
					} else {
						const block = toolBlocks.get(toolIndex)!;
						if (!block.id) { block.id = event.call.id; toolIndexById.set(block.id, toolIndex); }
						if (!block.name) block.name = event.call.name;
						// Argument deltas are authoritative; only replay the complete
						// arguments when the stream never sent any.
						if (!block.args && event.call.arguments) {
							block.args = event.call.arguments;
							chunks.push(anthropicEvent("content_block_delta", {
								index: block.index,
								delta: { type: "input_json_delta", partial_json: event.call.arguments },
							}));
						}
					}
					break;
				}
				case "usage":
					inputTokens = event.promptTokensTotal ?? event.promptTokens ?? inputTokens;
					outputTokens = event.completionTokensTotal ?? event.completionTokens ?? outputTokens;
					break;
				case "done":
					stopReason = event.finishReason;
					chunks.push(...finish());
					break;
				case "responses-reasoning":
				case "chat-reasoning":
					break;
			}
			return chunks;
		},
		end(): string[] {
			chunks.length = 0;
			if (!ended) chunks.push(...finish());
			return chunks;
		},
	};

	function finish(): string[] {
		ended = true;
		ensureStarted();
		stopTextBlocks();
		for (const block of [...toolBlocks.values()].sort((a, b) => a.index - b.index)) {
			chunks.push(anthropicEvent("content_block_stop", { index: block.index }));
		}
		const out = [...chunks];
		out.push(anthropicEvent("message_delta", {
			delta: { stop_reason: toAnthropicStopReason(stopReason), stop_sequence: null },
			usage: { output_tokens: outputTokens },
		}));
		out.push(anthropicEvent("message_stop", {}));
		chunks.length = 0;
		return out;
	}
}

// ---- Non-streaming aggregation ----

export interface AggregatedResponse {
	text: string;
	thinking: string;
	toolCalls: ToolCall[];
	usage: { prompt_tokens: number; completion_tokens: number };
	finishReason: string;
}

async function* toAsync(events: Iterable<ProviderEvent> | AsyncIterable<ProviderEvent>): AsyncGenerator<ProviderEvent> {
	if (Symbol.asyncIterator in (events as object)) {
		for await (const event of events as AsyncIterable<ProviderEvent>) yield event;
	} else {
		for (const event of events as Iterable<ProviderEvent>) yield event;
	}
}

export async function collectNonStreaming(events: Iterable<ProviderEvent> | AsyncIterable<ProviderEvent>): Promise<AggregatedResponse> {
	let text = "";
	let thinking = "";
	let finishReason = "stop";
	const usage = { prompt_tokens: 0, completion_tokens: 0 };
	const partial = new Map<number, { id: string; name: string; args: string }>();
	const completed: ToolCall[] = [];

	for await (const event of toAsync(events)) {
		switch (event.type) {
			case "text-delta":
				text += event.text;
				break;
			case "thinking-delta":
				thinking += event.text;
				break;
			case "tool-call-start":
				partial.set(event.index, { id: event.id, name: event.name, args: "" });
				break;
			case "tool-call-args-delta": {
				const entry = partial.get(event.index) ?? { id: "", name: "", args: "" };
				entry.args += event.delta;
				partial.set(event.index, entry);
				break;
			}
			case "tool-call": {
				let matched = false;
				for (const entry of partial.values()) {
					if (entry.id === event.call.id || (!entry.name && !entry.id)) {
						entry.id = event.call.id;
						entry.name = event.call.name;
						if (!entry.args) entry.args = event.call.arguments;
						matched = true;
						break;
					}
				}
				if (!matched) completed.push({ ...event.call });
				break;
			}
			case "usage":
				usage.prompt_tokens = event.promptTokensTotal ?? event.promptTokens ?? usage.prompt_tokens;
				usage.completion_tokens = event.completionTokensTotal ?? event.completionTokens ?? usage.completion_tokens;
				break;
			case "done":
				finishReason = event.finishReason;
				break;
			default:
				break;
		}
	}

	const toolCalls: ToolCall[] = [
		...[...partial.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, entry]) => ({ id: entry.id || `call_${randomUUID()}`, name: entry.name, arguments: entry.args || "{}" }))
			.filter((call) => !!call.name),
		...completed,
	];
	return { text, thinking, toolCalls, usage, finishReason };
}

export function openAIChatCompletionBody(model: string, agg: AggregatedResponse) {
	const message: Record<string, unknown> = { role: "assistant", content: agg.text || null };
	if (agg.toolCalls.length) {
		message.tool_calls = agg.toolCalls.map((call) => ({
			id: call.id,
			type: "function",
			function: { name: call.name, arguments: call.arguments },
		}));
	}
	return {
		id: `chatcmpl-${randomUUID()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{
			index: 0,
			message,
			finish_reason: toOpenAIStopReason(agg.finishReason),
		}],
		usage: {
			prompt_tokens: agg.usage.prompt_tokens,
			completion_tokens: agg.usage.completion_tokens,
			total_tokens: agg.usage.prompt_tokens + agg.usage.completion_tokens,
		},
	};
}

export function anthropicMessageBody(model: string, agg: AggregatedResponse) {
	const content: Record<string, unknown>[] = [];
	if (agg.text) content.push({ type: "text", text: agg.text });
	for (const call of agg.toolCalls) {
		let input: unknown = {};
		try { input = JSON.parse(call.arguments || "{}"); } catch { input = {}; }
		content.push({ type: "tool_use", id: call.id, name: call.name, input });
	}
	return {
		id: `msg_${randomBytes(12).toString("hex")}`,
		type: "message",
		role: "assistant",
		model,
		content,
		stop_reason: toAnthropicStopReason(agg.finishReason),
		stop_sequence: null,
		usage: {
			input_tokens: agg.usage.prompt_tokens,
			output_tokens: agg.usage.completion_tokens,
		},
	};
}
