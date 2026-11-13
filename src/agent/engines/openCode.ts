/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { spawn } from "node:child_process";
import * as net from "node:net";
import type { AgentEvent } from "../types";
import type { AgentEngine, EngineRuntime } from "./types";
import { cachedAvailability, killProcessTree, resolveEngineBinary, spawnCommand } from "./registry";

const OPENCODE_DEFAULT_PORT = 4096;
const HEALTH_TIMEOUT_MS = 1_500;
const SERVER_START_TIMEOUT_MS = 20_000;
const SERVER_POLL_INTERVAL_MS = 300;

/** Servers spawned by this adapter, kept warm across turns. */
const spawnedServers = new Map<number, ReturnType<typeof spawn>>();
let exitHookRegistered = false;

function registerExitHook(): void {
	if (exitHookRegistered) return;
	exitHookRegistered = true;
	process.on("exit", () => {
		for (const child of spawnedServers.values()) {
			try { child.kill(); } catch { /* best effort */ }
		}
	});
}

/** Stop every server this adapter spawned; used before uninstalling the CLI. */
export function stopOpenCodeServers(): void {
	for (const [port, child] of spawnedServers) {
		killProcessTree(child.pid);
		spawnedServers.delete(port);
	}
}

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => (port ? resolve(port) : reject(new Error("OpenCode engine: no free port available"))));
		});
	});
}

async function isHealthy(base: string): Promise<boolean> {
	try {
		const response = await fetch(`${base}/global/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Reuse a healthy server on the well-known port (adopted, not ours), otherwise
 * spawn `opencode serve` on a free port and wait for it. Spawned servers are
 * kept warm for later turns and killed when the extension host exits.
 */
async function ensureServer(binary: string, directory: string): Promise<string> {
	const defaultBase = `http://127.0.0.1:${OPENCODE_DEFAULT_PORT}`;
	if (await isHealthy(defaultBase)) return defaultBase;

	const port = await findFreePort();
	const base = `http://127.0.0.1:${port}`;
	// Windows shims are .cmd files: they can only be launched through cmd.exe,
	// which spawnCommand handles. A raw spawn fails with EINVAL in the
	// extension host even though the same command works in a terminal.
	let child: ReturnType<typeof spawn>;
	try {
		child = spawnCommand(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: directory });
	} catch (error) {
		throw new Error(`OpenCode engine: could not start opencode serve (${(error as Error).message})`);
	}
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr = (stderr + String(chunk)).slice(-2_000);
	});
	// Drain stdout so a chatty server never blocks on a full pipe.
	child.stdout?.resume();
	spawnedServers.set(port, child);
	registerExitHook();

	const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (child.exitCode != null || child.signalCode != null) {
			spawnedServers.delete(port);
			const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
			throw new Error(
				`OpenCode engine: opencode serve exited early (code ${child.exitCode ?? child.signalCode})` +
				(detail ? `: ${detail}` : ""),
			);
		}
		if (await isHealthy(base)) return base;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, SERVER_POLL_INTERVAL_MS));
	}
	spawnedServers.delete(port);
	try { child.kill(); } catch { /* best effort */ }
	const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
	throw new Error(
		`OpenCode engine: opencode serve did not become healthy within ${SERVER_START_TIMEOUT_MS / 1000}s` +
		(detail ? `: ${detail}` : ""),
	);
}

async function createSession(base: string, directory: string): Promise<string> {
	for (const body of [{ directory }, { cwd: directory }]) {
		try {
			const response = await fetch(`${base}/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!response.ok) continue;
			const data = response as unknown as { json: () => Promise<any> };
			const payload = await data.json();
			const id = payload?.id ?? payload?.sessionID ?? payload?.info?.id;
			if (typeof id === "string" && id) return id;
		} catch { /* try the next body shape */ }
	}
	throw new Error("OpenCode engine: could not create a session");
}

async function sendPrompt(base: string, sessionId: string, text: string): Promise<void> {
	const body = JSON.stringify({ parts: [{ type: "text", text }] });
	let response = await fetch(`${base}/session/${sessionId}/prompt_async`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
	if (response.status === 404 || response.status === 400) {
		response = await fetch(`${base}/session/${sessionId}/message`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
	}
	if (!response.ok) throw new Error(`OpenCode engine: prompt failed (${response.status})`);
}

/** Actions decoded from one SSE frame, mirroring the Claude parser style. */
export type OpenCodeAction =
	| { kind: "emit"; event: AgentEvent }
	| { kind: "permission"; requestId: string; toolName: string; input: unknown; callId?: string }
	| { kind: "retry"; attempt: number; error: string }
	| { kind: "error"; message: string }
	| { kind: "completed" };

/**
 * Map one OpenCode SSE event onto actions, filtered to the given session.
 * Liberal about payload shapes (string vs object fields) across server versions.
 */
export function handleOpenCodeEvent(frame: unknown, sessionId: string): OpenCodeAction[] {
	const msg = frame as { type?: string; properties?: Record<string, any> } | null;
	const props = msg?.properties ?? {};
	if (props.sessionID && props.sessionID !== sessionId) return [];
	switch (msg?.type) {
		case "message.part.delta": {
			const part = props.part;
			const partType = typeof part === "string" ? part : part?.type;
			const text = typeof props.delta?.text === "string" ? props.delta.text
				: typeof props.delta === "string" ? props.delta
				: typeof props.text === "string" ? props.text : "";
			if (!text) return [];
			if (partType === "thinking" || partType === "reasoning") return [{ kind: "emit", event: { type: "thinking-delta", text } }];
			return [{ kind: "emit", event: { type: "text-delta", text } }];
		}
		case "session.status": {
			const status = props.status;
			const statusType = typeof status === "string" ? status : status?.type;
			if (statusType === "idle") return [{ kind: "completed" }];
			if (statusType === "retry") {
				return [{ kind: "retry", attempt: Number(status?.attempt ?? 0), error: String(status?.message ?? "server retry") }];
			}
			return [];
		}
		case "session.error": {
			const message = props.error?.message ?? props.error ?? props.message ?? "session error";
			return [{ kind: "error", message: typeof message === "string" ? message : JSON.stringify(message) }];
		}
		case "permission.asked": {
			const requestId = String(props.id ?? props.requestId ?? props.requestID ?? "");
			if (!requestId) return [];
			// Liberal field mapping across server versions: `permission`/`type`
			// names the capability ("bash", "edit", …), `metadata`/`title` carries
			// the human-visible detail (command, file path, …).
			const toolName = String(props.permission ?? props.type ?? "opencode");
			const callId = typeof props.callID === "string" && props.callID ? props.callID : undefined;
			const input = props.metadata ?? props.title ?? {};
			return [{ kind: "permission", requestId, toolName, input, callId }];
		}
		case "question.asked":
			return []; // v1: interactive questions are ignored (the CLI picks defaults)
		default:
			return [];
	}
}

/** Parse complete SSE frames out of a raw text buffer. */
export function parseSseFrames(buffer: string): { events: unknown[]; rest: string } {
	const events: unknown[] = [];
	let rest = buffer;
	let separator: number;
	while ((separator = rest.indexOf("\n\n")) >= 0) {
		const block = rest.slice(0, separator);
		rest = rest.slice(separator + 2);
		const data = block.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data) continue;
		try { events.push(JSON.parse(data)); } catch { /* ignore malformed frames */ }
	}
	return { events, rest };
}

/**
 * Drive one turn through a local OpenCode server: subscribe to the event
 * stream first, create the session, then send the prompt asynchronously.
 */
export async function runOpenCode(rt: EngineRuntime): Promise<{ text: string; sessionId?: string }> {
	const binary = await resolveEngineBinary("opencode");
	if (!binary) throw new Error("OpenCode engine: the opencode CLI was not found on PATH");

	const base = await ensureServer(binary, rt.workspaceRoot);
	const controller = new AbortController();
	const sessionIdRef: { id: string } = { id: "" };
	const onAbort = () => {
		controller.abort();
		if (sessionIdRef.id) void fetch(`${base}/session/${sessionIdRef.id}/abort`, { method: "POST" }).catch(() => { /* best effort */ });
	};
	if (rt.signal.aborted) onAbort();
	else rt.signal.addEventListener("abort", onAbort, { once: true });

	try {
		// Subscribe before prompting so no early event is lost.
		const stream = await fetch(`${base}/event`, { signal: controller.signal });
		if (!stream.ok || !stream.body) throw new Error(`OpenCode engine: could not subscribe to events (${stream.status})`);

		const sessionId = await createSession(base, rt.workspaceRoot);
		sessionIdRef.id = sessionId;

		let text = "";
		let failure: Error | undefined;

		// Permission asks go through AiWorkHarness's approval UI. The reply is sent
		// without blocking the SSE reader; opencode parks the turn until the
		// permission is answered, so at most a few asks can be in flight.
		const handlePermission = async (action: Extract<OpenCodeAction, { kind: "permission" }>): Promise<void> => {
			let approved = false;
			try { approved = await rt.approve(action.toolName, action.input, action.callId); } catch { approved = false; }
			if (rt.signal.aborted) approved = false;
			try {
				await fetch(`${base}/permission/${action.requestId}/reply`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ reply: approved ? "once" : "reject" }),
				});
			} catch { /* best effort — the server also honors session abort */ }
		};

		const reader = (stream.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
		const decoder = new TextDecoder();
		let buffer = "";

		const pump = async (): Promise<void> => {
			try {
				while (true) {
					const { value, done } = await reader.next();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const { events, rest } = parseSseFrames(buffer);
					buffer = rest;
					for (const frame of events) {
						for (const action of handleOpenCodeEvent(frame, sessionId)) {
							if (action.kind === "emit") {
								if (action.event.type === "text-delta") text += action.event.text;
								rt.emit(action.event);
							} else if (action.kind === "permission") {
								void handlePermission(action);
							} else if (action.kind === "retry") {
								rt.emit({ type: "retry", attempt: action.attempt, max: action.attempt, delayMs: 0, error: action.error });
							} else if (action.kind === "error") {
								failure = new Error(action.message);
							} else if (action.kind === "completed") {
								return;
							}
						}
					}
					if (failure || rt.signal.aborted) return;
				}
			} catch (error) {
				if (!rt.signal.aborted) failure = error instanceof Error ? error : new Error(String(error));
			}
		};

		const pumpPromise = pump();
		await sendPrompt(base, sessionId, rt.prompt);

		const steeringTimer = setInterval(() => {
			rt.drainSteering().then((messages) => {
				for (const message of messages) void sendPrompt(base, sessionId, message).catch(() => { /* best effort */ });
			}).catch(() => { /* steering is best-effort */ });
		}, 500);

		try {
			await pumpPromise;
		} finally {
			clearInterval(steeringTimer);
			try { await reader.return?.(); } catch { /* stream already closed */ }
		}

		if (rt.signal.aborted) return { text, sessionId };
		if (failure) throw failure;
		return { text, sessionId };
	} finally {
		rt.signal.removeEventListener("abort", onAbort);
	}
}

export const openCodeEngine: AgentEngine = {
	id: "opencode",
	label: "OpenCode",
	async available() {
		const binary = await resolveEngineBinary("opencode");
		return cachedAvailability("opencode", binary, async () =>
			binary ? { ok: true, detail: binary } : { ok: false, detail: "the opencode CLI was not found on PATH" });
	},
	run(rt) {
		return runOpenCode(rt);
	},
};
