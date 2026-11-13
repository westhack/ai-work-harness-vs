/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { killProcessTree, spawnCommand, whereBinary } from "./engines/registry";
import { graphOutputRoot } from "./projectDocs/store";
import { recordCodeGraphEvent } from "../stores/codeGraphStats";

export type GraphifyPhase = "idle" | "detecting" | "extracting" | "clustering" | "verifying" | "done" | "error" | "cancelled";

export interface GraphifyStatus {
	phase: GraphifyPhase;
	message: string;
	error?: string;
	startedAt?: number;
	finishedAt?: number;
	logs: string[];
}

export interface KnowledgeGraphArtifacts {
	directory: string;
	json: string;
	html: string;
	report: string;
}

/** Minimal view of the task-bound model that graphify needs. */
export interface GraphifyModelRoute {
	kind: string;
	model: string;
	apiBaseUrl: string;
	apiKey: string;
	oauthKind?: string;
	apiKeyPool?: { firstApiKey(signal: AbortSignal): Promise<string | undefined> };
}

export interface GenerateKnowledgeGraphOptions {
	workspaceRoot: string;
	/** Absolute path to the CLI; resolved from PATH when omitted. */
	binary?: string;
	timeoutMs?: number;
	/** Resolve the task-bound model (from Settings) for graphify extraction. */
	resolveModel?: (signal: AbortSignal) => Promise<GraphifyModelRoute | undefined>;
}

export interface GenerateKnowledgeGraphResult {
	ok: boolean;
	cancelled?: boolean;
	error?: string;
	artifacts?: KnowledgeGraphArtifacts;
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const LOG_BYTES = 200_000;
const LOG_LINES = 200;
/** graphify backends read their credentials from the environment. */
const KEY_ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "MOONSHOT_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"];

function hasGraphifyKey(env: NodeJS.ProcessEnv): boolean {
	return KEY_ENV.some((key) => !!env[key]?.trim());
}

interface GraphifyBinding {
	backend: string;
	model: string;
	env: NodeJS.ProcessEnv;
}

/**
 * Map the task-bound model onto a graphify backend. Graphify only reads
 * credentials from the environment, so the selected provider's key and
 * endpoint are injected into the child process.
 */
async function resolveGraphifyBinding(
	options: GenerateKnowledgeGraphOptions,
	signal: AbortSignal,
): Promise<GraphifyBinding | undefined> {
	if (!options.resolveModel) return undefined;
	const route = await options.resolveModel(signal);
	if (!route) return undefined;
	signal.throwIfAborted();
	// OAuth accounts cannot hand a static key to an external CLI.
	if (route.oauthKind) return undefined;
	const apiKey = route.apiKey || (route.apiKeyPool ? await route.apiKeyPool.firstApiKey(signal) : "");
	signal.throwIfAborted();
	const kind = (route.kind || "").toLowerCase();
	const baseUrl = route.apiBaseUrl.replace(/\/+$/, "");
	const model = route.model;
	if (!model) return undefined;
	if (kind === "anthropic") {
		if (!apiKey) return undefined;
		return {
			backend: "claude",
			model,
			env: { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_MODEL: model, ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}) },
		};
	}
	if (kind === "google" || kind === "gemini") {
		if (!apiKey) return undefined;
		return { backend: "gemini", model, env: { GEMINI_API_KEY: apiKey, GOOGLE_API_KEY: apiKey } };
	}
	if (kind === "deepseek") {
		if (!apiKey) return undefined;
		return { backend: "deepseek", model, env: { DEEPSEEK_API_KEY: apiKey } };
	}
	if (kind === "moonshot" || kind === "kimi") {
		if (!apiKey) return undefined;
		return { backend: "kimi", model, env: { MOONSHOT_API_KEY: apiKey } };
	}
	if (kind === "ollama") {
		return { backend: "ollama", model, env: {} };
	}
	// Everything else speaks the OpenAI protocol (OpenRouter, xAI, local runtimes, ...).
	if (!baseUrl) return undefined;
	return {
		backend: "openai",
		model,
		env: { OPENAI_API_KEY: apiKey || "local", OPENAI_BASE_URL: baseUrl, OPENAI_MODEL: model },
	};
}

let status: GraphifyStatus = { phase: "idle", message: "", logs: [] };
const listeners = new Set<(next: GraphifyStatus) => void>();
let active: { controller: AbortController; child?: ChildProcess } | undefined;

export function onGraphifyStatus(listener: (next: GraphifyStatus) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getGraphifyStatus(): GraphifyStatus {
	return { ...status, logs: [...status.logs] };
}

export function isGraphifyRunning(): boolean {
	return !!active;
}

function publish(patch: Partial<GraphifyStatus>): void {
	status = { ...status, ...patch };
	for (const listener of listeners) {
		try { listener(getGraphifyStatus()); } catch { /* a broken listener must not stop the job */ }
	}
}

function log(line: string): void {
	const logs = [...status.logs, line.length > 2000 ? `${line.slice(0, 2000)}…` : line];
	if (logs.length > LOG_LINES) logs.splice(0, logs.length - LOG_LINES);
	publish({ logs });
}

export function cancelKnowledgeGraph(): void {
	if (!active) return;
	active.controller.abort(new Error("cancelled"));
	killProcessTree(active.child?.pid);
}

/** Where graphify writes its three artifacts for this workspace. */
export function knowledgeGraphArtifacts(workspaceRoot: string): KnowledgeGraphArtifacts | undefined {
	const root = graphOutputRoot(workspaceRoot);
	if (!root) return undefined;
	const directory = join(root, "graphify-out");
	return {
		directory,
		json: join(directory, "graph.json"),
		html: join(directory, "graph.html"),
		report: join(directory, "GRAPH_REPORT.md"),
	};
}

export async function findGraphify(): Promise<string | undefined> {
	return whereBinary("graphify");
}

/** Provenance stored inside graph.json so consumers can detect stale graphs. */
export interface GraphMetadata {
	tool: string;
	schema: number;
	generated_at: string;
	tool_version?: string;
	commit?: string;
}

/** `graphify --version` is cheap but optional: metadata must never fail a build. */
function readBinaryVersion(binary: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawnCommand(binary, ["--version"]);
		} catch {
			resolve(undefined);
			return;
		}
		let text = "";
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(text.trim().split(/\r?\n/)[0] || undefined);
		};
		const timer = setTimeout(() => {
			killProcessTree(child.pid);
			finish();
		}, 5000);
		child.stdout?.on("data", (chunk) => { if (text.length < 500) text += String(chunk); });
		child.stderr?.on("data", (chunk) => { if (text.length < 500) text += String(chunk); });
		child.on("error", finish);
		child.on("exit", finish);
	});
}

/** Commit the graph was built from; `.git` may be a file in worktrees. */
export async function readHeadCommit(workspaceRoot: string): Promise<string | undefined> {
	try {
		const git = join(workspaceRoot, ".git");
		const head = (await readFile(join(git, "HEAD"), "utf8")).trim();
		const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
		if (!ref) return head.length >= 7 ? head : undefined;
		try {
			const sha = (await readFile(join(git, ...ref.split("/")), "utf8")).trim();
			if (sha) return sha;
		} catch { /* refs are usually packed */ }
		const packed = await readFile(join(git, "packed-refs"), "utf8");
		const line = packed.split(/\r?\n/).find((entry) => entry.endsWith(` ${ref}`));
		return line?.split(" ")[0];
	} catch {
		return undefined;
	}
}

async function writeGraphMetadata(workspaceRoot: string, binary: string): Promise<void> {
	const artifacts = knowledgeGraphArtifacts(workspaceRoot);
	if (!artifacts) return;
	const [raw, toolVersion, commit] = await Promise.all([
		readFile(artifacts.json, "utf8"),
		readBinaryVersion(binary),
		readHeadCommit(workspaceRoot),
	]);
	const graph = JSON.parse(raw) as Record<string, unknown>;
	const previous = graph.metadata && typeof graph.metadata === "object" ? graph.metadata as Record<string, unknown> : {};
	const metadata: GraphMetadata = {
		...previous,
		tool: "graphify",
		schema: 1,
		generated_at: new Date().toISOString(),
		...(toolVersion ? { tool_version: toolVersion } : {}),
		...(commit ? { commit } : {}),
	};
	graph.metadata = metadata;
	await writeFile(artifacts.json, JSON.stringify(graph), "utf8");
}

/** Read the provenance block written after a successful build. */
export async function readGraphMetadata(workspaceRoot: string): Promise<GraphMetadata | undefined> {
	const artifacts = knowledgeGraphArtifacts(workspaceRoot);
	if (!artifacts) return undefined;
	try {
		const graph = JSON.parse(await readFile(artifacts.json, "utf8")) as Record<string, unknown>;
		const meta = graph.metadata;
		if (!meta || typeof meta !== "object") return undefined;
		const entry = meta as Record<string, unknown>;
		if (typeof entry.generated_at !== "string") return undefined;
		return {
			tool: typeof entry.tool === "string" ? entry.tool : "graphify",
			schema: typeof entry.schema === "number" ? entry.schema : 1,
			generated_at: entry.generated_at,
			tool_version: typeof entry.tool_version === "string" ? entry.tool_version : undefined,
			commit: typeof entry.commit === "string" ? entry.commit : undefined,
		};
	} catch {
		return undefined;
	}
}

/** Compact node/edge projection embedded in graphify's viewer HTML. */
export interface GraphView {
	nodes: Record<string, unknown>[];
	edges: Record<string, unknown>[];
}

/**
 * graphify's graph.html loads vis-network from a CDN and is therefore blank
 * inside a webview; the same data is embedded as single-line constants, so the
 * panel renders it itself instead of framing the HTML.
 */
export async function readGraphView(workspaceRoot: string): Promise<GraphView | undefined> {
	const artifacts = knowledgeGraphArtifacts(workspaceRoot);
	if (!artifacts) return undefined;
	let html: string;
	try {
		html = await readFile(artifacts.html, "utf8");
	} catch {
		return undefined;
	}
	const nodes = readEmbeddedArray(html, "RAW_NODES");
	const edges = readEmbeddedArray(html, "RAW_EDGES");
	if (!nodes || !edges) return undefined;
	return { nodes, edges };
}

/** Read `const NAME = [...];` from one line of the viewer template. */
function readEmbeddedArray(html: string, name: string): Record<string, unknown>[] | undefined {
	const marker = `const ${name} = `;
	const start = html.indexOf(marker);
	if (start < 0) return undefined;
	const from = start + marker.length;
	const newline = html.indexOf("\n", from);
	if (newline < 0) return undefined;
	const raw = html.slice(from, newline).trim().replace(/;$/, "");
	if (!raw.startsWith("[")) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : undefined;
	} catch {
		return undefined;
	}
}

/** Run one CLI step, keeping the tail of its output and honouring cancellation. */
function runCli(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ ok: boolean; detail?: string; output: string }> {
	return new Promise((resolve) => {
		let settled = false;
		let bytes = 0;
		const tail: string[] = [];
		const problems: string[] = [];
		let timer: NodeJS.Timeout | undefined;
		const finish = (result: { ok: boolean; detail?: string; output: string }) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (active) active.child = undefined;
			resolve(result);
		};
		let child: ChildProcess;
		try {
			child = spawnCommand(binary, args, { cwd, env });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			finish({ ok: false, detail: message, output: message });
			return;
		}
		if (active) active.child = child;
		const collect = (chunk: Buffer | string) => {
			const text = String(chunk);
			if (bytes >= LOG_BYTES) return;
			bytes += text.length;
			for (const line of text.split(/\r?\n/)) if (line.trim()) {
				tail.push(line);
				if (tail.length > 40) tail.shift();
				// Keep diagnostic lines: graphify prints the fatal reason before the warnings.
				if (/error|failed|empty|exception|traceback|not found|no nodes/i.test(line) && problems.length < 10) problems.push(line);
				log(line);
			}
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.on("error", (error) => finish({ ok: false, detail: error.message, output: tail.join("\n") }));
		child.on("exit", (code) => {
			const output = tail.join("\n");
			if (code === 0) {
				finish({ ok: true, output });
				return;
			}
			// The fatal line is the most useful one; the tail also carries progress noise.
			const fatal = [...tail].reverse().find((line) => /\[graphify extract\]\s*error:|^error:/i.test(line));
			const detail = fatal ?? [...new Set([...problems, ...tail.slice(-3)])].join(" | ");
			finish({ ok: false, detail: `graphify exited with code ${code}${detail ? `: ${detail}` : ""}`, output });
		});
		timer = setTimeout(() => {
			killProcessTree(child.pid);
			finish({ ok: false, detail: `graphify timed out after ${Math.round(timeoutMs / 60000)} minutes.`, output: tail.join("\n") });
		}, timeoutMs);
	});
}

export async function generateKnowledgeGraph(options: GenerateKnowledgeGraphOptions): Promise<GenerateKnowledgeGraphResult> {
	if (active) return { ok: false, error: "Knowledge graph generation is already running." };
	const artifacts = knowledgeGraphArtifacts(options.workspaceRoot);
	if (!artifacts) return { ok: false, error: "Documentation storage is unavailable." };
	const controller = new AbortController();
	active = { controller };
	status = { phase: "detecting", message: "", logs: [], startedAt: Date.now() };
	publish({});
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	try {
		const binary = options.binary?.trim() || await findGraphify();
		if (!binary) throw new Error("graphify was not found. Install it or set aiworkharness.graphifyPath.");
		controller.signal.throwIfAborted();
		log(`Using ${binary}`);

		// graphify writes into <workspace>/.docs/graphify-out; clear stale files so a
		// failed run cannot be mistaken for a fresh one.
		await rm(artifacts.directory, { recursive: true, force: true });
		await mkdir(artifacts.directory, { recursive: true });
		publish({ phase: "extracting" });
		const outDir = join(artifacts.directory, "..");
		let binding: GraphifyBinding | undefined;
		try {
			binding = await resolveGraphifyBinding(options, controller.signal);
		} catch (error) {
			if (controller.signal.aborted) throw error;
			log(`! Task model unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (controller.signal.aborted) throw new Error("cancelled");
		// Prefer the task-bound model; fall back to environment credentials, then to
		// a local AST-only graph when neither is available.
		const codeOnly = !binding && !hasGraphifyKey(process.env);
		const runEnv: NodeJS.ProcessEnv = { ...process.env, ...(binding?.env ?? {}) };
		const backendArgs = binding ? ["--backend", binding.backend, "--model", binding.model] : [];
		if (binding) {
			log(`Graphify model: ${binding.model} (${binding.backend})`);
		} else if (codeOnly) {
			log("No usable model binding found; indexing code only (docs, papers and images are skipped).");
			log("Pick a Graphify model in Settings, or set a provider key in the environment, for a full graph.");
		}
		/** Run extraction; `--code-only` never touches the network or needs a key. */
		const runExtract = (useCodeOnly: boolean, noGitignore: boolean) => runCli(
			binary,
			[
				"extract",
				options.workspaceRoot,
				"--out",
				outDir,
				...(useCodeOnly ? ["--code-only"] : backendArgs),
				...(noGitignore ? ["--no-gitignore"] : []),
			],
			options.workspaceRoot,
			runEnv,
			timeoutMs,
		);
		let effectiveCodeOnly = codeOnly;
		let extracted = await runExtract(effectiveCodeOnly, false);
		if (controller.signal.aborted) throw new Error("cancelled");
		if (!extracted.ok && /no llm api key/i.test(extracted.output)) {
			log("graphify needs a key for non-code files; retrying with --code-only");
			effectiveCodeOnly = true;
			extracted = await runExtract(true, false);
			if (controller.signal.aborted) throw new Error("cancelled");
		}
		// A reachable AST pass still produces a useful graph, so an unavailable or
		// failing semantic backend must not discard the whole run.
		if (!extracted.ok && !effectiveCodeOnly) {
			log("Semantic extraction failed; indexing code only (docs, papers and images are skipped)");
			log(extracted.detail ?? "graphify extract failed.");
			effectiveCodeOnly = true;
			extracted = await runExtract(true, false);
			if (controller.signal.aborted) throw new Error("cancelled");
		}
		// An empty graph usually means every source file was ignored or unclassified;
		// retry once with VCS ignore rules disabled before giving up.
		if (!extracted.ok && /found 0 code/i.test(extracted.output)) {
			log("No code files were classified; retrying with --no-gitignore");
			extracted = await runExtract(effectiveCodeOnly, true);
			if (controller.signal.aborted) throw new Error("cancelled");
		}
		if (!extracted.ok) {
			// Only claim "no source files" when graphify really classified none; a
			// failed semantic chunk also mentions "no nodes" and must not be misread.
			const empty = /found 0 code/i.test(extracted.output);
			throw new Error(empty
				? `graphify found no supported source files under ${options.workspaceRoot}. XML, .iml and other unclassified files are skipped; open the folder that contains the actual source code.`
				: extracted.detail ?? "graphify extract failed.");
		}
		if (!existsSync(artifacts.json)) throw new Error("graphify did not produce graph.json.");

		publish({ phase: "clustering" });
		const clustered = await runCli(
			binary,
			[
				"cluster-only",
				outDir,
				"--graph",
				artifacts.json,
				...(binding ? [`--backend=${binding.backend}`, `--model=${binding.model}`] : []),
				...(effectiveCodeOnly ? ["--no-label"] : []),
			],
			options.workspaceRoot,
			{ ...runEnv, GRAPHIFY_OUT: artifacts.directory },
			timeoutMs,
		);
		if (controller.signal.aborted) throw new Error("cancelled");
		if (!clustered.ok) throw new Error(clustered.detail ?? "graphify cluster-only failed.");

		publish({ phase: "verifying" });
		const missing = [artifacts.json, artifacts.html, artifacts.report].filter((file) => !existsSync(file));
		if (missing.length) throw new Error(`graphify did not produce ${missing.map((file) => file.split(/[\\/]/).pop()).join(", ")}.`);
		try {
			await writeGraphMetadata(options.workspaceRoot, binary);
		} catch (error) {
			// A graph without provenance is still usable; never fail the build for it.
			log(`! Graph metadata not written: ${error instanceof Error ? error.message : String(error)}`);
		}
		publish({ phase: "done", finishedAt: Date.now() });
		log("Knowledge graph is ready.");
		recordCodeGraphEvent(options.workspaceRoot, { type: "build", ok: true });
		return { ok: true, artifacts };
	} catch (error) {
		if (controller.signal.aborted) {
			publish({ phase: "cancelled", finishedAt: Date.now() });
			log("Cancelled.");
			return { ok: false, cancelled: true };
		}
		const message = error instanceof Error ? error.message : String(error);
		publish({ phase: "error", error: message, finishedAt: Date.now() });
		log(`Error: ${message}`);
		recordCodeGraphEvent(options.workspaceRoot, { type: "build", ok: false });
		return { ok: false, error: message };
	} finally {
		active = undefined;
	}
}
