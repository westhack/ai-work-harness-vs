/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "../types";
import type { StreamChatOpts } from "../provider/types";
import { ModelBridge, type ModelBridgeDeps } from "./server";

function scriptedStream(events: ProviderEvent[]): ModelBridgeDeps["streamChat"] {
	return (_opts: StreamChatOpts) => (async function* () {
		for (const event of events) yield event;
	})();
}

function depsWith(streamChat: ModelBridgeDeps["streamChat"]): ModelBridgeDeps {
	return {
		streamChat,
		resolveModel: vi.fn(async (requested: string) => ({
			apiBaseUrl: "http://127.0.0.1:1",
			apiKey: "secret",
			model: requested || "default-model",
			anthropic: false,
		})),
		listModels: () => ["alpha", "beta"],
	};
}

const headers = (token: string) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

let bridge: ModelBridge | undefined;

afterEach(async () => {
	await bridge?.stop();
	bridge = undefined;
});

describe("ModelBridge", () => {
	it("rejects missing and wrong tokens with protocol-specific 401 bodies", async () => {
		bridge = new ModelBridge(depsWith(scriptedStream([{ type: "text-delta", text: "x" }, { type: "done", finishReason: "stop" }])));
		const { url } = await bridge.start();

		const missing = await fetch(`${url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		expect(missing.status).toBe(401);
		expect(await missing.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });

		const wrong = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: headers("wrong"), body: "{}" });
		expect(wrong.status).toBe(401);
		expect(await wrong.json()).toMatchObject({ error: { type: "authentication_error" } });
	});

	it("streams Anthropic events for POST /v1/messages", async () => {
		bridge = new ModelBridge(depsWith(scriptedStream([
			{ type: "text-delta", text: "hello" },
			{ type: "done", finishReason: "stop" },
		])));
		const { url, token } = await bridge.start();

		const response = await fetch(`${url}/v1/messages`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({ model: "claude-test", max_tokens: 32, stream: true, messages: [{ role: "user", content: "hi" }] }),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const text = await response.text();
		expect(text).toContain("event: message_start");
		expect(text.indexOf("event: message_start")).toBeLessThan(text.indexOf("event: content_block_start"));
		expect(text).toContain('"type":"text_delta"');
		expect(text).toContain("event: message_stop");
	});

	it("returns a non-streaming OpenAI chat completion for POST /v1/chat/completions", async () => {
		bridge = new ModelBridge(depsWith(scriptedStream([
			{ type: "text-delta", text: "answer" },
			{ type: "usage", promptTokens: 7, completionTokens: 2 },
			{ type: "done", finishReason: "stop" },
		])));
		const { url, token } = await bridge.start();

		const response = await fetch(`${url}/v1/chat/completions`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(response.status).toBe(200);
		const body = await response.json() as any;
		expect(body).toMatchObject({
			object: "chat.completion",
			model: "gpt-test",
			choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
		});
	});

	it("lists models on GET /v1/models", async () => {
		bridge = new ModelBridge(depsWith(scriptedStream([])));
		const { url, token } = await bridge.start();
		const response = await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
		expect(response.status).toBe(200);
		const body = await response.json() as any;
		expect(body.object).toBe("list");
		expect(body.data.map((model: { id: string }) => model.id)).toEqual(["alpha", "beta"]);
	});

	it("answers the startup probe on HEAD /api/hello without auth", async () => {
		bridge = new ModelBridge(depsWith(scriptedStream([])));
		const { url } = await bridge.start();
		const response = await fetch(`${url}/api/hello`, { method: "HEAD" });
		expect(response.status).toBe(200);
	});

	it("estimates input tokens for POST /v1/messages/count_tokens", async () => {
		bridge = new ModelBridge(depsWith(scriptedStream([])));
		const { url, token } = await bridge.start();

		const response = await fetch(`${url}/v1/messages/count_tokens`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({
				model: "claude-test",
				system: "be brief",
				messages: [{ role: "user", content: [{ type: "text", text: "hello world" }] }],
				tools: [{ name: "Read", description: "read a file", input_schema: { type: "object" } }],
			}),
		});
		expect(response.status).toBe(200);
		const body = await response.json() as any;
		expect(body.input_tokens).toBeGreaterThan(0);
	});

	it("answers model resolution failures with a 400 Anthropic error body", async () => {
		const deps = depsWith(scriptedStream([]));
		deps.resolveModel = vi.fn(async () => {
			throw new Error("No provider is configured for the selected model");
		});
		bridge = new ModelBridge(deps);
		const { url, token } = await bridge.start();

		const response = await fetch(`${url}/v1/messages`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({ model: "unknown-model", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
		});
		expect(response.status).toBe(400);
		const body = await response.json() as any;
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("invalid_request_error");
		expect(body.error.message).toContain("No provider is configured");
	});

	it("logs request, resolution and errors without exposing credentials", async () => {
		const logs: string[] = [];
		const deps = depsWith(scriptedStream([{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }]));
		deps.log = (level, message) => { logs.push(`${level} ${message}`); };
		bridge = new ModelBridge(deps);
		const { url, token } = await bridge.start();

		await fetch(`${url}/v1/messages`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({ model: "claude-test", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
		});
		expect(logs.some((line) => line.includes("POST /v1/messages model=claude-test stream=false"))).toBe(true);
		expect(logs.some((line) => line.includes("resolved model=claude-test provider=openai"))).toBe(true);
		const joined = logs.join("\n");
		expect(joined).not.toContain(token);
		expect(joined).not.toContain("secret");
	});

	it("aborts the upstream stream when the client disconnects", async () => {
		let aborted = false;
		const stream: ModelBridgeDeps["streamChat"] = (opts) => (async function* () {
			yield { type: "text-delta", text: "first" };
			await new Promise<void>((resolve) => {
				opts.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
			});
		})();
		bridge = new ModelBridge(depsWith(stream));
		const { url, token } = await bridge.start();

		const controller = new AbortController();
		const response = await fetch(`${url}/v1/messages`, {
			method: "POST",
			headers: headers(token),
			body: JSON.stringify({ model: "claude-test", max_tokens: 32, stream: true, messages: [{ role: "user", content: "hi" }] }),
			signal: controller.signal,
		});
		const reader = response.body!.getReader();
		await reader.read();
		controller.abort();
		await vi.waitFor(() => expect(aborted).toBe(true));
	});

	it("stops accepting connections after stop()", async () => {
		bridge = new ModelBridge(depsWith(scriptedStream([])));
		const { url } = await bridge.start();
		await bridge.stop();
		await expect(fetch(`${url}/health`)).rejects.toThrow();
		bridge = undefined;
	});
});
