/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ProviderEvent } from "../types";
import type { StreamChatOpts } from "../provider/types";
import type { ApiKeyPool } from "../provider/apiKeyPool";
import type { OAuthKind } from "../oauth/types";
import {
	anthropicErrorBody,
	anthropicMessageBody,
	collectNonStreaming,
	createAnthropicStreamEncoder,
	createOpenAIStreamEncoder,
	fromAnthropicMessagesRequest,
	fromOpenAIChatRequest,
	openAIChatCompletionBody,
	openAIErrorBody,
	type BridgeChatRequest,
} from "./translate";

export type BridgeModelResolution = {
	apiBaseUrl: string;
	apiKey: string;
	apiKeyPool?: ApiKeyPool;
	model: string;
	anthropic: boolean;
	oauthKind?: OAuthKind;
	providerAdapterId?: string;
};

export type ModelBridgeDeps = {
	streamChat: typeof import("../provider").streamChat;
	resolveModel: (requested: string) => Promise<BridgeModelResolution>;
	listModels?: () => string[];
	/** Diagnostics sink. Messages never include request bodies, tokens or API keys. */
	log?: (level: "info" | "warn" | "error", message: string) => void;
};

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const ADDRESS = "127.0.0.1";

type WireKind = "openai" | "anthropic";

class BodyTooLargeError extends Error {}
class InvalidBodyError extends Error {}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let tooLarge = false;
		req.on("data", (chunk: Buffer | string) => {
			if (tooLarge) return;
			const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			size += buffer.length;
			if (size > MAX_BODY_BYTES) {
				tooLarge = true;
				chunks.length = 0;
				return;
			}
			chunks.push(buffer);
		});
		req.on("end", () => {
			if (tooLarge) { reject(new BodyTooLargeError()); return; }
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (!text) { resolve({}); return; }
			try {
				resolve(JSON.parse(text));
			} catch {
				reject(new InvalidBodyError());
			}
		});
		req.on("error", reject);
	});
}

function bearerToken(req: IncomingMessage): string | undefined {
	const header = req.headers.authorization;
	if (typeof header === "string" && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, "").trim();
	const key = req.headers["x-api-key"];
	return Array.isArray(key) ? key[0] : key;
}

function sameSecret(a: string | undefined, b: string): boolean {
	if (!a) return false;
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Local protocol bridge: exposes OpenAI Chat Completions and Anthropic Messages
 * over 127.0.0.1, translating each request onto AiWorkHarness's streamChat().
 */
export class ModelBridge {
	private _server: Server | undefined;
	private _endpoint: { url: string; token: string } | undefined;
	private _token = "";

	constructor(private readonly deps: ModelBridgeDeps) {}

	get endpoint(): { url: string; token: string } | undefined {
		return this._endpoint;
	}

	async start(): Promise<{ url: string; token: string }> {
		if (this._server && this._endpoint) return this._endpoint;
		this._token = randomBytes(32).toString("hex");
		const server = createServer((req, res) => {
			void this._handle(req, res).catch((error) => {
				if (res.headersSent) { res.end(); return; }
				this._sendError(res, 500, "openai", "server_error", error instanceof Error ? error.message : "Internal bridge error");
			});
		});
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
			const onListening = () => { server.off("error", onError); resolve(); };
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(0, ADDRESS);
		});
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		this._server = server;
		this._endpoint = { url: `http://${ADDRESS}:${port}`, token: this._token };
		return this._endpoint;
	}

	async stop(): Promise<void> {
		const server = this._server;
		this._server = undefined;
		this._endpoint = undefined;
		this._token = "";
		if (!server) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 1000);
			timer.unref?.();
			server.close(() => { clearTimeout(timer); resolve(); });
			server.closeAllConnections?.();
		});
	}

	private async _handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const path = (req.url ?? "/").split("?")[0];
		if (req.method === "GET" && path === "/health") {
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
			return;
		}
		// Claude Code probes this endpoint on startup to detect a gateway. It is
		// unauthenticated by design and carries no data, so answer it directly.
		if ((req.method === "HEAD" || req.method === "GET") && path === "/api/hello") {
			res.writeHead(200, { "content-type": "application/json" }).end(req.method === "HEAD" ? undefined : JSON.stringify({ ok: true }));
			return;
		}
		const isModels = req.method === "GET" && path === "/v1/models";
		const isCountTokens = req.method === "POST" && path === "/v1/messages/count_tokens";
		const kind: WireKind | undefined = path === "/v1/chat/completions" ? "openai"
			: path === "/v1/messages" || isCountTokens ? "anthropic" : undefined;

		if (!isModels && (!kind || req.method !== "POST")) {
			this._sendError(res, 404, kind ?? "openai", "not_found_error", `Unknown route: ${req.method ?? "?"} ${path}`);
			return;
		}
		if (!this._authorized(req)) {
			this._sendError(res, 401, kind ?? "openai", "authentication_error", "Invalid or missing API token");
			return;
		}
		if (isModels) {
			const data = (this.deps.listModels?.() ?? []).map((id) => ({ id, object: "model", created: 0, owned_by: "aiworkharness" }));
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data }));
			return;
		}

		let body: unknown;
		try {
			body = await readBody(req);
		} catch (error) {
			if (error instanceof BodyTooLargeError) {
				this._sendError(res, 413, kind!, "invalid_request_error", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
				return;
			}
			this._sendError(res, 400, kind!, "invalid_request_error", "Request body must be valid JSON");
			return;
		}

		if (isCountTokens) {
			const parsed = fromAnthropicMessagesRequest(body);
			this._log("info", `POST ${path} model=${parsed.model || "(none)"} stream=false`);
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: estimateInputTokens(parsed) }));
			return;
		}

		const parsed: BridgeChatRequest = kind === "anthropic" ? fromAnthropicMessagesRequest(body) : fromOpenAIChatRequest(body);
		this._log("info", `POST ${path} model=${parsed.model || "(none)"} stream=${parsed.stream}`);
		await this._complete(kind!, parsed, res);
	}

	private _authorized(req: IncomingMessage): boolean {
		return sameSecret(bearerToken(req), this._token);
	}

	private _log(level: "info" | "warn" | "error", message: string): void {
		try {
			this.deps.log?.(level, message);
		} catch {
			// Diagnostics must never fail a request.
		}
	}

	private _sendError(res: ServerResponse, status: number, kind: WireKind, type: string, message: string): void {
		this._log("error", `status=${status} ${message}`);
		if (res.headersSent) { res.end(); return; }
		const body = kind === "anthropic" ? anthropicErrorBody(type, message) : openAIErrorBody(message, type);
		res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
	}

	private async _complete(kind: WireKind, parsed: BridgeChatRequest, res: ServerResponse): Promise<void> {
		const controller = new AbortController();
		// A disconnected client must stop the upstream stream. `req` emits "close"
		// for normal request completion too, so the response is the reliable signal.
		let abortLogged = false;
		const abortForClient = () => {
			if (!abortLogged) { abortLogged = true; this._log("warn", "client aborted"); }
			controller.abort();
		};
		res.on("close", () => { if (!res.writableEnded) abortForClient(); });
		reqAborted(res, abortForClient);

		let resolution: BridgeModelResolution;
		try {
			resolution = await this._resolveModel(parsed.model);
		} catch (error) {
			// Model resolution failures are user-correctable (pick a model/provider),
			// so answer 400: a 5xx makes the CLIs retry until they give up.
			this._sendError(res, 400, kind, "invalid_request_error", error instanceof Error ? error.message : "No provider serves the requested model");
			return;
		}
		this._log("info", `resolved model=${resolution.model || parsed.model || "(none)"} provider=${resolution.anthropic ? "anthropic" : "openai"}`);

		const model = parsed.model || resolution.model;
		const opts: StreamChatOpts = {
			apiBaseUrl: resolution.apiBaseUrl,
			apiKey: resolution.apiKey,
			...(resolution.apiKeyPool ? { apiKeyPool: resolution.apiKeyPool } : {}),
			...(resolution.providerAdapterId ? { providerAdapterId: resolution.providerAdapterId } : {}),
			model: resolution.model || parsed.model,
			messages: parsed.messages,
			...(parsed.tools?.length ? { tools: parsed.tools } : {}),
			...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
			...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
			...(parsed.stopSequences?.length ? { sampling: { stopSequences: parsed.stopSequences } } : {}),
			anthropic: resolution.anthropic,
			...(resolution.oauthKind ? { oauthKind: resolution.oauthKind } : {}),
			signal: controller.signal,
		};

		if (parsed.stream) {
			await this._stream(kind, model, opts, res, controller.signal);
		} else {
			await this._nonStreaming(kind, model, opts, res, controller.signal);
		}
	}

	private async _resolveModel(requested: string): Promise<BridgeModelResolution> {
		try {
			return await this.deps.resolveModel(requested.trim());
		} catch (error) {
			if (!requested.trim()) throw error;
			// Let the host decide its default model when the engine asks for an id
			// this installation has not configured.
			return await this.deps.resolveModel("");
		}
	}

	private async _stream(kind: WireKind, model: string, opts: StreamChatOpts, res: ServerResponse, signal: AbortSignal): Promise<void> {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.flushHeaders?.();
		const encoder = kind === "anthropic" ? createAnthropicStreamEncoder(model) : createOpenAIStreamEncoder(model);
		try {
			for await (const event of this.deps.streamChat(opts) as AsyncGenerator<ProviderEvent>) {
				if (signal.aborted || res.writableEnded) return;
				for (const chunk of encoder.push(event)) res.write(chunk);
			}
			if (!signal.aborted && !res.writableEnded) {
				for (const chunk of encoder.end()) res.write(chunk);
			}
		} catch (error) {
			if (signal.aborted || res.writableEnded) return;
			const message = error instanceof Error ? error.message : "Upstream stream failed";
			this._log("error", `status=500 ${message}`);
			const frame = kind === "anthropic"
				? `event: error\ndata: ${JSON.stringify(anthropicErrorBody("api_error", message))}\n\n`
				: `data: ${JSON.stringify(openAIErrorBody(message, "server_error"))}\n\n`;
			res.write(frame);
		} finally {
			if (!res.writableEnded) res.end();
		}
	}

	private async _nonStreaming(kind: WireKind, model: string, opts: StreamChatOpts, res: ServerResponse, signal: AbortSignal): Promise<void> {
		try {
			const events: ProviderEvent[] = [];
			for await (const event of this.deps.streamChat(opts) as AsyncGenerator<ProviderEvent>) {
				if (signal.aborted) return;
				events.push(event);
			}
			if (signal.aborted || res.writableEnded) return;
			const aggregate = await collectNonStreaming(events);
			const body = kind === "anthropic" ? anthropicMessageBody(model, aggregate) : openAIChatCompletionBody(model, aggregate);
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
		} catch (error) {
			if (signal.aborted) return;
			this._sendError(res, 500, kind, "api_error", error instanceof Error ? error.message : "Upstream request failed");
		}
	}
}

/** Rough prompt-size estimate for Anthropic's count_tokens endpoint. */
function estimateInputTokens(request: BridgeChatRequest): number {
	let chars = 0;
	for (const message of request.messages) {
		if (typeof message.content === "string") {
			chars += message.content.length;
		} else if (Array.isArray(message.content)) {
			for (const part of message.content) if (part.type === "text") chars += part.text.length;
		}
	}
	if (request.tools?.length) chars += JSON.stringify(request.tools).length;
	return Math.max(1, Math.ceil(chars / 4));
}

/** Bridge premature request closes onto the abort callback (older Node emits "aborted"). */
function reqAborted(res: ServerResponse, onAbort: () => void): void {
	const req = res.req;
	if (!req) return;
	req.on("aborted", onAbort);
	// A normal request also emits "close" once its body is consumed; only an
	// incomplete request means the peer went away.
	req.on("close", () => { if (!req.complete) onAbort(); });
}
