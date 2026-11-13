/*
 * Copyright (c) 2026 westhack <https://github.com/westhack>
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket = require("ws");
import type { AgentEvent } from "../types";
import type { AgentEngine, EngineRuntime } from "./types";
import { cachedAvailability, killProcessTree, resolveEngineBinary, spawnCommand } from "./registry";

/**
 * DeepSeek Harness (DSH) engine adapter — drives one turn through a local
 * `dsh web` host session. Wire protocol below is ported 1:1 from the verified
 * reference client (desktop-cc-gui-main/src-tauri/src/dsh_host.rs and
 * engine/dsh_session.rs, verified live against dsh 0.1.2):
 *
 * - RPC is plain HTTP, cookie-authenticated (BrowserAuth):
 *   `POST {origin}/api/<method>` with
 *   `{type:"client-request",rpcId,method,payload:{args}}` →
 *   `{type:"server-response",rpcId,result:{ok:true,value}|{ok:false,error}}`.
 * - A spawned host prints a one-time launch token
 *   (`dsh web: http://…/?token=…`) on stdout; exchanging it via
 *   `GET {origin}/?token=…` (303 + set-cookie, never follow the redirect)
 *   yields the auth cookie used on every later request.
 * - Turn flow: `workspace/create` → `session/create` → open the mux WS
 *   (`ws://{authority}/api/remote.mux`) with a `session/follow` subscription
 *   carrying `assistantStream: true` plus a `$events` subscription →
 *   `session/prompt` (mode "queue") → pump frames → `turn/end` settles.
 *   Interrupt sends `session/cancel`; steering queues another `session/prompt`.
 */

const DSH_DEFAULT_PORT = 3080;
const DESCRIBE_METHOD = "settings/describe";
const HEALTH_TIMEOUT_MS = 1_500;
const RPC_TIMEOUT_MS = 10_000;
/** Windows npm shims chain cmd → node and cold-start slowly (dsh_host.rs). */
const HOST_START_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;
const HOST_POLL_INTERVAL_MS = 250;
/** Token exchange retries while the host finishes binding its listener. */
const TOKEN_EXCHANGE_ATTEMPTS = 6;
const TOKEN_EXCHANGE_RETRY_MS = 400;
const FOLLOW_READY_TIMEOUT_MS = 5_000;
const WS_OPEN_TIMEOUT_MS = 10_000;
const STEERING_INTERVAL_MS = 500;
const OUTPUT_TAIL_LINES = 20;

// ==================== pure protocol helpers ====================

/**
 * Scan one line of host output for the one-time launch token
 * (`dsh web: http://…/?token=<A-Za-z0-9_->`). Ported from dsh_host.rs
 * `extract_launch_token`: the token must sit in a query string (`?token=` /
 * `&token=`) and stops at the first non-URL-safe character.
 */
export function extractLaunchToken(line: string): string | undefined {
	const needle = "token=";
	let from = 0;
	while (true) {
		const at = line.indexOf(needle, from);
		if (at < 0) return undefined;
		from = at + needle.length;
		if (at > 0 && line[at - 1] !== "?" && line[at - 1] !== "&") continue;
		const rest = line.slice(from);
		const match = /^[A-Za-z0-9_-]*/.exec(rest);
		if (match && match[0].length > 0) return match[0];
	}
}

/** One client-request envelope body (`payload.args` wraps the call args). */
export function buildRpcEnvelope(method: string, args: unknown): string {
	return JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload: { args } });
}

/** Decode one server-response body into `{ok,value}` / `{ok,error}`. */
export function parseRpcResult(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
	let envelope: any;
	try { envelope = JSON.parse(text); } catch { return { ok: false, error: "malformed server response (non-JSON)" }; }
	if (envelope?.type !== "server-response") return { ok: false, error: "malformed server response (not server-response)" };
	const result = envelope.result;
	if (result?.ok === true) return { ok: true, value: result.value };
	const message = typeof result?.error?.message === "string" ? result.error.message : "unknown error";
	return { ok: false, error: message };
}

/** Resolve a JSON-pointer-like path ("​/workspace/workspaceId") to a string. */
function valueAt(value: unknown, pointer: string): string | undefined {
	let node: any = value;
	for (const segment of pointer.split("/").filter(Boolean)) {
		if (node == null || typeof node !== "object") return undefined;
		node = node[segment];
	}
	return typeof node === "string" && node ? node : undefined;
}

/** session/prompt args (mode "queue", content parts — dsh_session.rs). */
export function buildPromptRequest(sessionId: string, text: string): unknown {
	return {
		request: {
			requestId: `aiworkharness-${randomUUID()}`,
			sessionId,
			mode: "queue",
			content: [{ type: "text", text }],
			clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
		},
	};
}

/**
 * Map a follow-stream `usage` chunk onto a usage AgentEvent. Field names
 * follow the host's usage convention (`input_tokens`/`output_tokens`, as read
 * by the reference reader and chat UI; cache counters optional).
 */
function usageEvent(usage: Record<string, unknown>): AgentEvent {
	const promptTokens = Number(usage.input_tokens ?? 0) || 0;
	const completionTokens = Number(usage.output_tokens ?? 0) || 0;
	const cachedRead = Number(usage.cache_read_input_tokens ?? Number.NaN);
	const cachedWrite = Number(usage.cache_creation_input_tokens ?? Number.NaN);
	return {
		type: "usage",
		promptTokens,
		completionTokens,
		totalTokens: Number(usage.total_tokens ?? 0) || promptTokens + completionTokens,
		source: "parent",
		cachedReadTokens: Number.isFinite(cachedRead) ? cachedRead : undefined,
		cachedWriteTokens: Number.isFinite(cachedWrite) ? cachedWrite : undefined,
	};
}

/** Durable `assistant/message` → plain text (concatenated text blocks). */
function assistantMessageText(data: any): string {
	const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
	return blocks
		.filter((block: any) => block?.type === "text")
		.map((block: any) => (typeof block.text === "string" ? block.text : ""))
		.join("");
}

// ==================== frame parser (pure, testable) ====================

/** Actions decoded from one mux WS frame; the run loop executes them. */
export type DshAction =
	| { kind: "emit"; event: AgentEvent }
	/** `$events` ready frame: clientId required on every `$events/result`. */
	| { kind: "events-client"; clientId: string }
	/** `approval/request` waterfall — answered through rt.approve. */
	| { kind: "approval"; eventId: string; toolName: string; input: unknown }
	/** Interactive request AiWorkHarness dismisses (questions / unknown kinds). */
	| { kind: "dismiss"; eventId: string }
	/** `turn/end` — the durable settlement of the turn. */
	| { kind: "turn-ended"; reason: string };

/**
 * Stateful parser for the DSH mux frames (`{type:"item",streamId,value}`).
 * Pure with respect to I/O — every outcome is returned as actions so tests
 * can feed recorded frames (shapes copied from dsh_session.rs) without a
 * host. Follow-stream deltas are deduplicated against the durable
 * `assistant/message` the same way the reference does.
 */
export class DshFrameParser {
	private toolNames = new Map<string, string>();
	private attemptStreamedText = false;

	handleFrame(text: string): DshAction[] {
		let frame: any;
		try { frame = JSON.parse(text); } catch { return []; }
		if (frame?.type !== "item") return [];
		if (frame.streamId === "follow") return this.handleFollow(frame.value);
		if (frame.streamId === "events") return this.handleEvents(frame.value);
		return [];
	}

	private handleFollow(value: any): DshAction[] {
		switch (value?.type) {
			case "snapshot": return []; // history replay; AiWorkHarness renders its own transcript
			case "event": {
				const event = value.event ?? {};
				return this.handleSessionEvent(String(event.type ?? ""), event.data ?? {});
			}
			case "assistant-stream": return this.handleAssistantStream(value.frame ?? {});
			default: return [];
		}
	}

	private handleSessionEvent(eventType: string, data: any): DshAction[] {
		switch (eventType) {
			case "tool/call": {
				const name = typeof data.name === "string" && data.name ? data.name : "tool";
				const callId = typeof data.callId === "string" ? data.callId : "";
				if (callId) this.toolNames.set(callId, name);
				let input: unknown = {};
				if (typeof data.arguments === "string") {
					try { input = JSON.parse(data.arguments); } catch { input = data.arguments; }
				} else if (data.arguments != null) {
					input = data.arguments;
				}
				return [{ kind: "emit", event: { type: "tool-call-started", callId, name, input } }];
			}
			case "tool/result": {
				const callId = typeof data?.message?.source?.callId === "string" ? data.message.source.callId : "";
				const name = this.toolNames.get(callId) ?? (callId || "tool");
				const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
				const result = blocks.map((block: any) => (typeof block?.text === "string" ? block.text : ""))
					.filter(Boolean).join("\n");
				const isError = blocks.some((block: any) => block?.isError === true);
				return [{ kind: "emit", event: {
					type: "tool-call-completed",
					callId,
					name,
					status: isError ? "error" : "completed",
					result,
				} }];
			}
			case "assistant/message": {
				// Settlement of the streamed attempt: render only when the live
				// deltas never flowed, else the text would appear twice.
				const streamed = this.attemptStreamedText;
				this.attemptStreamedText = false;
				if (streamed) return [];
				const text = assistantMessageText(data);
				return text ? [{ kind: "emit", event: { type: "text-delta", text: `${text}\n\n` } }] : [];
			}
			case "turn/end":
				return [{ kind: "turn-ended", reason: String(data?.reason?.kind ?? "completed") }];
			default:
				return []; // user/message / step/* / system/message / title / plan/mode
		}
	}

	private handleAssistantStream(frame: any): DshAction[] {
		switch (frame?.type) {
			case "start":
				this.attemptStreamedText = false;
				return [];
			case "chunk": {
				const chunk = frame.chunk ?? {};
				switch (chunk.type) {
					case "text-delta": {
						const text = typeof chunk.text === "string" ? chunk.text : "";
						if (!text) return [];
						this.attemptStreamedText = true;
						return [{ kind: "emit", event: { type: "text-delta", text } }];
					}
					case "reasoning-delta": {
						const text = typeof chunk.text === "string" ? chunk.text : "";
						return text ? [{ kind: "emit", event: { type: "thinking-delta", text } }] : [];
					}
					case "usage": {
						if (!chunk.usage || typeof chunk.usage !== "object") return [];
						return [{ kind: "emit", event: usageEvent(chunk.usage) }];
					}
					default: return []; // block-start / block-end / tool-call-delta / finish
				}
			}
			default: return []; // end frames: the durable events settle the turn
		}
	}

	private handleEvents(value: any): DshAction[] {
		switch (value?.type) {
			case "ready":
				return typeof value.clientId === "string" && value.clientId
					? [{ kind: "events-client", clientId: value.clientId }]
					: [];
			case "waterfall": {
				const eventId = typeof value.eventId === "string" ? value.eventId : "";
				if (!eventId) return [];
				if (value.event === "approval/request") {
					// The reference client auto-allows approval waterfalls without
					// reading any tool fields, so the request payload shape is
					// TODO(unverified) — we pass it through as approval input and
					// read a tool name only if the host happens to include one.
					const request = value.request ?? {};
					const toolName = typeof request?.tool === "string" && request.tool ? request.tool : "dsh";
					return [{ kind: "approval", eventId, toolName, input: request }];
				}
				// user-questions/request and unrecognized interactive intents:
				// AiWorkHarness has no question card yet, so dismiss exactly like
				// the reference's unanswered-question path (question_outcome).
				return [{ kind: "dismiss", eventId }];
			}
			default: return []; // cancel: nothing parked on the AiWorkHarness side
		}
	}
}

// ==================== transport (injectable) ====================

export type DshFetch = (url: string, init?: {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}) => Promise<{ status: number; text: () => Promise<string> }>;

/** Minimal WS surface the turn loop needs; real impl wraps the `ws` package. */
export interface DshSocket {
	send(text: string): void;
	close(): void;
	onOpen(listener: () => void): void;
	onMessage(listener: (data: unknown) => void): void;
	onError(listener: (error: Error) => void): void;
	onClose(listener: () => void): void;
}

export interface DshDeps {
	resolveBinary: () => Promise<string | undefined>;
	spawn: (binary: string, args: string[]) => ChildProcess;
	fetch: DshFetch;
	exchangeToken: (origin: string, token: string) => Promise<string | undefined>;
	connectWs: (url: string, cookie?: string) => DshSocket;
	findFreePort: () => Promise<number>;
	killTree: (pid: number | undefined) => void;
}

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => (port ? resolve(port) : reject(new Error("DeepSeek Harness engine: no free port available"))));
		});
	});
}

/**
 * Launch-token → cookie exchange: `GET {origin}/?token=…` must NOT follow the
 * redirect — the host answers 303 + set-cookie (dsh_host.rs `exchange_token`).
 * Node fetch turns `redirect:"manual"` into an opaque header-less response, so
 * this uses a raw http request. (Local origins are always plain http.)
 */
function defaultExchangeToken(origin: string, token: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		let url: URL;
		try { url = new URL(`${origin}/?token=${encodeURIComponent(token)}`); }
		catch { resolve(undefined); return; }
		const request = httpRequest(
			{
				hostname: url.hostname,
				port: Number(url.port) || 80,
				path: `${url.pathname}${url.search}`,
				method: "GET",
				headers: { connection: "close" },
			},
			(response) => {
				response.resume(); // drain the body
				const setCookie = response.headers["set-cookie"] ?? [];
				const pair = setCookie[0]?.split(";")[0]?.trim();
				resolve(response.statusCode === 303 && pair ? pair : undefined);
			},
		);
		request.setTimeout(HEALTH_TIMEOUT_MS, () => { request.destroy(); resolve(undefined); });
		request.on("error", () => resolve(undefined));
		request.end();
	});
}

function defaultConnectWs(url: string, cookie?: string): DshSocket {
	const socket = new WebSocket(url, { headers: cookie ? { Cookie: cookie } : undefined });
	const on = (event: string) => (listener: (value: any) => void) => { socket.on(event, listener); };
	return {
		send: (text) => {
			if (socket.readyState === WebSocket.OPEN) socket.send(text);
		},
		close: () => {
			try { socket.close(); } catch { /* already closed */ }
		},
		onOpen: on("open"),
		onMessage: on("message"),
		onError: on("error"),
		onClose: on("close"),
	};
}

function defaultFetch(url: string, init?: Parameters<DshFetch>[1]) {
	return fetch(url, init);
}

/** Desktop-app install fallback: dsh ships inside DeepSeek Harness Desktop. */
function desktopInstallBinary(): string | undefined {
	if (process.platform !== "win32") return undefined;
	const roots = [
		process.env["ProgramFiles"] ?? "C:\\Program Files",
		process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
	];
	for (const root of roots) {
		const dir = join(root, "DeepSeek Harness Desktop", "resources", "dsh");
		try {
			if (!existsSync(dir)) continue;
			for (const entry of readdirSync(dir)) {
				const shim = join(dir, entry, "node_modules", ".bin", "dsh.cmd");
				if (existsSync(shim)) return shim;
			}
		} catch { /* unreadable install dir */ }
	}
	return undefined;
}

let cachedDesktopBinary: string | undefined;

function defaultDeps(): DshDeps {
	return {
		resolveBinary: async () => {
			const onPath = await resolveEngineBinary("dsh");
			if (onPath) return onPath;
			if (cachedDesktopBinary === undefined) cachedDesktopBinary = desktopInstallBinary();
			return cachedDesktopBinary;
		},
		spawn: (binary, args) => spawnCommand(binary, args),
		fetch: defaultFetch,
		exchangeToken: defaultExchangeToken,
		connectWs: defaultConnectWs,
		findFreePort,
		killTree: killProcessTree,
	};
}

// ==================== host lifecycle (adopt-or-spawn, kept warm) ====================

/** Hosts spawned by this adapter, kept warm across turns. */
const spawnedHosts = new Map<number, ChildProcess>();
/** Per-origin BrowserAuth cookie captured from the launch token. */
const hostCookies = new Map<string, string>();
/** The host this adapter last spawned, reused across turns. */
let ownedHost: { origin: string; port: number } | undefined;
let exitHookRegistered = false;

function registerExitHook(): void {
	if (exitHookRegistered) return;
	exitHookRegistered = true;
	process.on("exit", () => {
		for (const child of spawnedHosts.values()) {
			try { child.kill(); } catch { /* best effort */ }
		}
	});
}

/** Stop every host this adapter spawned; used before uninstalling the CLI. */
export function stopDshHosts(): void {
	for (const [port, child] of spawnedHosts) {
		killProcessTree(child.pid);
		spawnedHosts.delete(port);
	}
	hostCookies.clear();
	ownedHost = undefined;
}

type ProbeOutcome = { kind: "live" } | { kind: "unauthorized" } | { kind: "down" };

/** One `settings/describe` round-trip; 401 means alive but credential-locked. */
async function probeHost(origin: string, cookie: string | undefined, deps: DshDeps): Promise<ProbeOutcome> {
	try {
		const response = await deps.fetch(`${origin}/api/${DESCRIBE_METHOD}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
			body: buildRpcEnvelope(DESCRIBE_METHOD, {}),
			signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
		});
		if (response.status === 401) return { kind: "unauthorized" };
		return parseRpcResult(await response.text()).ok ? { kind: "live" } : { kind: "down" };
	} catch {
		return { kind: "down" };
	}
}

async function hostCall(origin: string, cookie: string | undefined, method: string, args: unknown, deps: DshDeps): Promise<unknown> {
	const response = await deps.fetch(`${origin}/api/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
		body: buildRpcEnvelope(method, args),
		signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
	});
	if (response.status === 401) {
		throw new Error(`DeepSeek Harness engine: ${method} was rejected (401) — the host did not accept our credentials`);
	}
	const parsed = parseRpcResult(await response.text());
	if (!parsed.ok) throw new Error(`DeepSeek Harness engine: ${method} was rejected: ${parsed.error}`);
	return parsed.value;
}

async function exchangeWithRetries(origin: string, token: string, deps: DshDeps): Promise<string | undefined> {
	for (let attempt = 0; attempt < TOKEN_EXCHANGE_ATTEMPTS; attempt++) {
		const cookie = await deps.exchangeToken(origin, token);
		if (cookie) return cookie;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, TOKEN_EXCHANGE_RETRY_MS));
	}
	return undefined;
}

/**
 * Adopt a healthy host on the well-known port, else reuse the host we spawned
 * earlier, else spawn `dsh web` on a free port and wait for readiness —
 * capturing the launch token from stdout and exchanging it for the auth
 * cookie along the way (dsh_host.rs ensure_host). Deviation from the
 * reference: a credential-locked foreign listener on the default port is left
 * alone (AiWorkHarness never kills another app's host); we spawn our own
 * instance on a free port instead.
 */
async function ensureHost(binary: string, deps: DshDeps): Promise<{ origin: string; cookie?: string }> {
	const defaultOrigin = `http://127.0.0.1:${DSH_DEFAULT_PORT}`;
	const defaultCookie = hostCookies.get(defaultOrigin);
	if ((await probeHost(defaultOrigin, defaultCookie, deps)).kind === "live") {
		return { origin: defaultOrigin, cookie: defaultCookie };
	}
	if (ownedHost) {
		const cookie = hostCookies.get(ownedHost.origin);
		if ((await probeHost(ownedHost.origin, cookie, deps)).kind === "live") {
			return { origin: ownedHost.origin, cookie };
		}
		ownedHost = undefined;
	}

	const port = await deps.findFreePort();
	const origin = `http://127.0.0.1:${port}`;
	const child = deps.spawn(binary, ["web", "--host", "127.0.0.1", "--port", String(port), "--no-open"]);
	spawnedHosts.set(port, child);
	registerExitHook();

	const tail: string[] = [];
	let launchToken: string | undefined;
	let pending = "";
	const watchOutput = (stream: NodeJS.ReadableStream | null) => {
		if (!stream) return;
		stream.on("data", (chunk: Buffer | string) => {
			pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			let index: number;
			while ((index = pending.indexOf("\n")) >= 0) {
				const line = pending.slice(0, index).trim();
				pending = pending.slice(index + 1);
				if (!line) continue;
				tail.push(line);
				if (tail.length > OUTPUT_TAIL_LINES) tail.splice(0, tail.length - OUTPUT_TAIL_LINES);
				if (!launchToken) launchToken = extractLaunchToken(line);
			}
		});
	};
	watchOutput(child.stdout);
	watchOutput(child.stderr);

	const deadline = Date.now() + HOST_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (child.exitCode != null || child.signalCode != null) {
			spawnedHosts.delete(port);
			throw new Error(`DeepSeek Harness engine: dsh web exited early (code ${child.exitCode ?? child.signalCode})${tail.length ? `: ${tail.join("\n").slice(-800)}` : ""}`);
		}
		if (!hostCookies.has(origin) && launchToken) {
			const cookie = await exchangeWithRetries(origin, launchToken, deps);
			if (cookie) hostCookies.set(origin, cookie);
		}
		const cookie = hostCookies.get(origin);
		if ((await probeHost(origin, cookie, deps)).kind === "live") {
			ownedHost = { origin, port };
			return { origin, cookie };
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, HOST_POLL_INTERVAL_MS));
	}
	spawnedHosts.delete(port);
	deps.killTree(child.pid);
	const tokenNote = launchToken && !hostCookies.has(origin) ? " (launch token seen but the cookie exchange failed)" : "";
	throw new Error(`DeepSeek Harness engine: dsh web did not become healthy within ${HOST_START_TIMEOUT_MS / 1000}s${tokenNote}${tail.length ? `: ${tail.join("\n").slice(-800)}` : ""}`);
}

// ==================== turn flow ====================

/** Wait for the mux handshake (ws resolves "open" only after the handshake). */
function waitOpen(socket: DshSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		let done = false;
		const timer = setTimeout(() => finish(new Error("DeepSeek Harness engine: session stream connection timed out")), WS_OPEN_TIMEOUT_MS);
		const finish = (error?: Error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (error) reject(error); else resolve();
		};
		socket.onOpen(() => finish());
		socket.onError((error) => finish(new Error(`DeepSeek Harness engine: session stream connection failed (${error?.message ?? error})`)));
	});
}

/**
 * Open both logical streams and wait for the follow snapshot (proof the
 * subscription is live) plus the `$events` ready frame (its clientId heads
 * every `$events/result` answer) — with a bounded fallback so a gateway that
 * skips either cannot stall sends (dsh_session.rs ws_open_and_wait). Returns
 * the events clientId when the ready frame arrived in time.
 */
async function openMuxStreams(socket: DshSocket, sessionId: string): Promise<string | undefined> {
	socket.send(JSON.stringify({
		type: "open",
		streamId: "follow",
		endpoint: "session/follow",
		payload: { args: { request: {
			address: { kind: "session", sessionId },
			maxMessages: 1,
			assistantStream: true,
		} } },
	}));
	socket.send(JSON.stringify({
		type: "open",
		streamId: "events",
		endpoint: "$events",
		payload: { args: {} },
	}));
	return await new Promise<string | undefined>((resolve) => {
		let followReady = false;
		let clientId: string | undefined;
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(clientId);
		};
		const timer = setTimeout(finish, FOLLOW_READY_TIMEOUT_MS);
		const check = () => {
			if (followReady && clientId) finish();
		};
		socket.onMessage((data) => {
			let frame: any;
			try { frame = JSON.parse(frameText(data)); } catch { return; }
			if (frame?.type !== "item") return;
			if (frame.streamId === "follow" && frame.value?.type === "snapshot") {
				followReady = true;
				check();
			} else if (frame.streamId === "events" && frame.value?.type === "ready"
				&& typeof frame.value.clientId === "string") {
				clientId = frame.value.clientId;
				check();
			}
		});
	});
}

function frameText(data: unknown): string {
	if (typeof data === "string") return data;
	if (Buffer.isBuffer(data)) return data.toString("utf8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	return "";
}

/**
 * Drive one turn through a local DSH host session (dsh_session.rs
 * run_host_turn / turn_inner): workspace → session → mux streams → prompt →
 * pump frames until `turn/end`. Approvals go through AiWorkHarness's approval
 * UI; steering queues follow-up prompts on the same session.
 */
export async function runDsh(rt: EngineRuntime, deps: DshDeps = defaultDeps()): Promise<{ text: string; sessionId?: string }> {
	const binary = await deps.resolveBinary();
	if (!binary) throw new Error("DeepSeek Harness engine: the dsh CLI was not found on PATH or under Program Files");

	const { origin, cookie } = await ensureHost(binary, deps);

	const workspaceId = valueAt(
		await hostCall(origin, cookie, "workspace/create", { request: { path: rt.workspaceRoot } }, deps),
		"/workspace/workspaceId",
	);
	if (!workspaceId) throw new Error("DeepSeek Harness engine: workspace/create returned no workspaceId");
	const sessionId = valueAt(
		await hostCall(origin, cookie, "session/create", { request: { workspaceId } }, deps),
		"/sessionId",
	);
	if (!sessionId) throw new Error("DeepSeek Harness engine: session/create returned no sessionId");
	// EngineRuntime carries no model id, so session/selectModel is skipped and
	// the session keeps the host's default model.

	const socket = deps.connectWs(`${origin.replace(/^http/, "ws")}/api/remote.mux`, cookie);
	await waitOpen(socket);
	let eventsClientId = await openMuxStreams(socket, sessionId);
	// One parser for the whole turn: it tracks callId → tool names and the
	// streamed-attempt flag the durable assistant/message settlement needs.
	const parser = new DshFrameParser();

	let lastText = "";
	let settled = false;
	const startedAt = Date.now();

	try {
		await new Promise<void>((resolveLoop, rejectLoop) => {
			let steeringTimer: NodeJS.Timeout | undefined;
			const settle = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearInterval(steeringTimer);
				rt.signal.removeEventListener("abort", onAbort);
				socket.close();
				if (error && !rt.signal.aborted) rejectLoop(error);
				else resolveLoop();
			};
			const onAbort = () => {
				// Server-side cancel; the host is shared and kept warm, so the
				// process is never killed on cancel.
				void hostCall(origin, cookie, "session/cancel", { request: { sessionId } }, deps)
					.catch(() => { /* best effort — the host may already be gone */ });
				settle();
			};
			if (rt.signal.aborted) onAbort();
			else rt.signal.addEventListener("abort", onAbort, { once: true });

			// Steering queued mid-run is queued as follow-up prompts (mode
			// "queue" — dsh_session.rs sends every message through
			// session/prompt).
			steeringTimer = setInterval(() => {
				rt.drainSteering().then((messages) => {
					for (const text of messages) {
						void hostCall(origin, cookie, "session/prompt", buildPromptRequest(sessionId, text), deps)
							.catch(() => { /* steering is best-effort */ });
					}
				}).catch(() => { /* steering is best-effort */ });
			}, STEERING_INTERVAL_MS);

			const answerWaterfall = (eventId: string, outcome: unknown) => {
				// $events/result args carry clientId/eventId/outcome directly
				// (no `request` wrapper — dsh_session.rs).
				void hostCall(origin, cookie, "$events/result", { clientId: eventsClientId, eventId, outcome }, deps)
					.catch(() => { /* best effort — the host also honors session cancel */ });
			};
			const handleApproval = async (action: Extract<DshAction, { kind: "approval" }>) => {
				let approved = false;
				try { approved = await rt.approve(action.toolName, action.input, action.eventId); } catch { approved = false; }
				if (rt.signal.aborted) approved = false;
				answerWaterfall(action.eventId, approved
					? { kind: "result", value: "allowed-once" }
					: { kind: "rejected", error: { code: "cancelled", message: "Denied by the user in AiWorkHarness" } });
			};

			const handleAction = (action: DshAction) => {
				if (action.kind === "emit") {
					if (action.event.type === "text-delta") lastText += action.event.text;
					rt.emit(action.event);
				} else if (action.kind === "events-client") {
					eventsClientId = action.clientId;
				} else if (action.kind === "approval") {
					if (!eventsClientId) return; // answer requires the ready clientId
					void handleApproval(action);
				} else if (action.kind === "dismiss") {
					if (!eventsClientId) return;
					answerWaterfall(action.eventId, {
						kind: "rejected",
						error: { name: "UserQuestionError", code: "cancelled", message: "the user cancelled ask_user_question" },
					});
				} else if (action.kind === "turn-ended") {
					rt.emit({ type: "run-result", text: lastText, durationMs: Date.now() - startedAt });
					settle();
				}
			};

			socket.onMessage((data) => {
				for (const action of parser.handleFrame(frameText(data))) {
					handleAction(action);
				}
				if (rt.signal.aborted) settle();
			});
			socket.onError((error) => {
				settle(new Error(`DeepSeek Harness engine: session stream error (${error?.message ?? error})`));
			});
			socket.onClose(() => {
				settle(new Error("DeepSeek Harness engine: session stream closed before the turn ended"));
			});

			// Streams must be live before the prompt so no turn event races the
			// subscription (dsh_session.rs turn_inner ordering).
			void (async () => {
				try {
					await hostCall(origin, cookie, "session/prompt", buildPromptRequest(sessionId, rt.prompt), deps);
				} catch (error) {
					settle(error instanceof Error ? error : new Error(String(error)));
				}
			})();
		});
	} finally {
		// Defensive close for paths that settle without going through the
		// socket handlers (prompt RPC failure, abort before listeners attach).
		socket.close();
	}

	return { text: lastText, sessionId };
}

export const dshEngine: AgentEngine = {
	id: "dsh",
	label: "DeepSeek Harness",
	experimental: true,
	async available() {
		const binary = await resolveEngineBinary("dsh").then((onPath) => onPath ?? desktopInstallBinary());
		return cachedAvailability("dsh", binary, async () =>
			binary ? { ok: true, detail: binary } : { ok: false, detail: "the dsh CLI was not found on PATH or under Program Files" });
	},
	run(rt) {
		return runDsh(rt);
	},
};
