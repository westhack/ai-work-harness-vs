/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SettingsManager } from "../../stores/settingsManager";
import type { FeatureStore } from "../../stores/featureStore";
import { optionsToParams } from "../../stores/featureStore";
import { recordUsage } from "../../stores/usageStore";
import type { UiLanguage } from "../../shared/i18n";
import { stripReasoning } from "../../shared/reasoning";
import { resolveRoute } from "../docsPlanner";
import { runAgent } from "../loop";
import { streamChat } from "../provider";
import {
	affectedPages,
	changedSince,
	gitHead,
	readSourceExcerpts,
	scanWorkspace,
	selectSourceFiles,
	type ScannedFile,
} from "./scan";
import {
	parseCatalogAnswer,
	pageFilePath,
	projectDocsRoot,
	readManifest,
	readPage,
	translationDir,
	writeManifest,
	writeMindMap,
	writePage,
	type ProjectDocCatalogNode,
	type ProjectDocPage,
	type ProjectDocsManifest,
} from "./store";
import {
	catalogSystemPrompt,
	ensureDocSkills,
	mindmapSystemPrompt,
	pageResearchSystemPrompt,
	pageWriteSystemPrompt,
	translationSystemPrompt,
} from "./skillPrompts";
import { PAGE_COMPLETE_SENTINEL } from "./prompts";

export type ProjectDocsPhase =
	| "idle"
	| "scanning"
	| "catalog"
	| "pages"
	| "finalizing"
	| "translating"
	| "mindmap"
	| "done"
	| "error"
	| "cancelled";

export interface ProjectDocsStatus {
	phase: ProjectDocsPhase;
	message: string;
	done: number;
	total: number;
	page?: string;
	error?: string;
	startedAt?: number;
	finishedAt?: number;
	logs: string[];
}

export interface GenerateProjectDocsOptions {
	workspaceRoot: string;
	settingsManager: SettingsManager;
	featureStore: FeatureStore;
	language: UiLanguage;
	/** Full rebuilds the catalog; incremental reuses it and regenerates affected pages. */
	mode: "full" | "incremental";
	/** Regenerate only these slugs (used by "regenerate this page"). */
	only?: string[];
}

export interface GenerateProjectDocsResult {
	ok: boolean;
	cancelled?: boolean;
	error?: string;
	generated: number;
	failed: number;
}

const CONCURRENCY = 3;
const MAX_PAGE_TOKENS = 8000;
const MAX_CATALOG_TOKENS = 8192;
const MAX_RESEARCH_STEPS = 30;
const MAX_WRITE_ROUNDS = 5;
const MAX_BRIEF_CHARS = 24_000;
const MAX_EVIDENCE_CHARS = 90_000;
const MAX_EVIDENCE_FILE_CHARS = 12_000;
const LOG_LINES = 200;

let status: ProjectDocsStatus = { phase: "idle", message: "", done: 0, total: 0, logs: [] };
const listeners = new Set<(next: ProjectDocsStatus) => void>();
let active: AbortController | undefined;

export function onProjectDocsStatus(listener: (next: ProjectDocsStatus) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getProjectDocsStatus(): ProjectDocsStatus {
	return { ...status, logs: [...status.logs] };
}

export function isProjectDocsRunning(): boolean {
	return !!active;
}

function publish(patch: Partial<ProjectDocsStatus>): void {
	status = { ...status, ...patch };
	for (const listener of listeners) {
		try { listener(getProjectDocsStatus()); } catch { /* a broken listener must not stop generation */ }
	}
}

function log(line: string): void {
	const logs = [...status.logs, line];
	if (logs.length > LOG_LINES) logs.splice(0, logs.length - LOG_LINES);
	publish({ logs });
}

export function cancelProjectDocs(): void {
	active?.abort(new Error("cancelled"));
}

const SYSTEM_LANGUAGE: Record<UiLanguage, string> = { en: "English", "zh-CN": "Simplified Chinese" };

/** Generation limits; every value is user-overridable from Settings. */
export interface DocsLimits {
	maxPages: number;
	maxCatalogFiles: number;
	maxInputChars: number;
	maxFileBytes: number;
	catalogSteps: number;
	mindmapSteps: number;
	mindmapTokens: number;
}

export const DEFAULT_DOCS_LIMITS: DocsLimits = {
	maxPages: 90,
	maxCatalogFiles: 4000,
	maxInputChars: 80_000,
	maxFileBytes: 1024 * 1024,
	catalogSteps: 50,
	mindmapSteps: 40,
	mindmapTokens: 8192,
};

/** Settings store shape used by {@link docsLimits}; all fields are optional and 0 means default. */
export interface DocsLimitsConfig {
	docsMaxPages?: number;
	docsMaxCatalogFiles?: number;
	docsMaxCatalogChars?: number;
	docsMaxFileKb?: number;
	docsCatalogSteps?: number;
	docsMindmapSteps?: number;
	docsMindmapTokens?: number;
}

function positive(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function docsLimits(config: DocsLimitsConfig): DocsLimits {
	return {
		maxPages: positive(config.docsMaxPages, DEFAULT_DOCS_LIMITS.maxPages),
		maxCatalogFiles: positive(config.docsMaxCatalogFiles, DEFAULT_DOCS_LIMITS.maxCatalogFiles),
		maxInputChars: positive(config.docsMaxCatalogChars, DEFAULT_DOCS_LIMITS.maxInputChars),
		maxFileBytes: positive(config.docsMaxFileKb, DEFAULT_DOCS_LIMITS.maxFileBytes / 1024) * 1024,
		catalogSteps: positive(config.docsCatalogSteps, DEFAULT_DOCS_LIMITS.catalogSteps),
		mindmapSteps: positive(config.docsMindmapSteps, DEFAULT_DOCS_LIMITS.mindmapSteps),
		mindmapTokens: positive(config.docsMindmapTokens, DEFAULT_DOCS_LIMITS.mindmapTokens),
	};
}

/** README and the build manifest give the catalog agent its product-level signals. */
async function readCatalogSignals(root: string): Promise<string> {
	const read = async (name: string, limit: number): Promise<string | undefined> => {
		try {
			const text = await readFile(join(root, name), "utf8");
			return text.slice(0, limit);
		} catch {
			return undefined;
		}
	};
	const readme = await read("README.md", 5000) ?? await read("readme.md", 5000) ?? await read("README.rst", 3000);
	const manifests = [
		"package.json", "pyproject.toml", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts",
		"settings.gradle", "settings.gradle.kts", "go.mod", "composer.json", "Gemfile",
	];
	let manifestName = "";
	let manifest: string | undefined;
	for (const name of manifests) {
		manifest = await read(name, 5000);
		if (manifest) { manifestName = name; break; }
	}
	const parts: string[] = [];
	if (readme) parts.push(`README:\n${readme}`);
	if (manifest) parts.push(`${manifestName}:\n${manifest}`);
	// Maven and Gradle module lists reveal every module without reading the whole build file.
	if (manifest) {
		const maven = [...manifest.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((match) => match[1].trim());
		const gradle = [...manifest.matchAll(/include\s*\(?\s*([^\n)]*)/g)]
			.flatMap((match) => [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1].replace(/^:/, "").replace(/:/g, "/")));
		const modules = maven.length ? maven : gradle;
		if (modules.length) parts.push(`Modules:\n${modules.join("\n")}`);
	}
	return parts.join("\n\n");
}

/**
 * Compact repository inventory. Every module directory is reported so the model
 * cannot silently drop a subsystem, and the file listing is ordered by path
 * (not size) to keep module coverage instead of the largest files.
 */
function catalogUserPayload(
	root: string,
	files: ScannedFile[],
	language: UiLanguage,
	limits: DocsLimits,
	signals = "",
	phase = "catalog",
): string {
	const topLevel = new Map<string, number>();
	const modules = new Map<string, number>();
	for (const file of files) {
		const parts = file.path.split("/");
		const top = parts.length > 1 ? parts[0] : ".";
		topLevel.set(top, (topLevel.get(top) ?? 0) + 1);
		// Two levels keep Maven/Gradle modules visible even when they sit one layer deep.
		for (const depth of [2, 3]) {
			if (parts.length > depth) {
				const dir = parts.slice(0, depth).join("/");
				modules.set(dir, (modules.get(dir) ?? 0) + 1);
			}
		}
	}
	const listing: string[] = [];
	const payload: Record<string, unknown> = {
		repository: root.split(/[\\/]/).filter(Boolean).pop() ?? root,
		phase,
		language: SYSTEM_LANGUAGE[language],
		fileCount: files.length,
		topLevel: [...topLevel.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, files: count })),
		moduleDirectories: [...modules.entries()]
			.filter(([, count]) => count >= 3)
			.sort((a, b) => a[0].localeCompare(b[0]))
			.slice(0, 300)
			.map(([name, count]) => ({ name, files: count })),
		readmeAndManifest: signals,
		files: listing,
		filesTruncated: false,
	};
	let used = JSON.stringify(payload).length;
	for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
		if (listing.length >= limits.maxCatalogFiles) break;
		const extra = file.path.length + 3;
		if (used + extra > limits.maxInputChars) break;
		listing.push(file.path);
		used += extra;
	}
	payload.filesTruncated = listing.length < files.length;
	return JSON.stringify(payload);
}

/** A disposed job must not wait for the provider's next stream event. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
		operation.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => {
			signal.removeEventListener("abort", abort);
			reject(error);
		});
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

/** Resolve a bound task model, falling back to the chat model when it is unavailable. */
async function routeFor(
	options: { settingsManager: SettingsManager; featureStore: FeatureStore },
	preferred: string | undefined,
	signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof resolveRoute>>> {
	const bound = preferred?.trim();
	try {
		return await resolveRoute(options.settingsManager, options.featureStore, signal, bound || undefined);
	} catch (error) {
		if (!bound) throw error;
		log(`! Task model "${bound}" is unavailable; using the chat model`);
		return resolveRoute(options.settingsManager, options.featureStore, signal);
	}
}

/** Accumulate a plain text completion; tools are never enabled for these calls. */
async function complete(
	settings: SettingsManager,
	store: FeatureStore,
	signal: AbortSignal,
	system: string,
	user: string,
	maxTokens: number,
	preferredModel?: string,
): Promise<{ text: string; model: string }> {
	let route: Awaited<ReturnType<typeof resolveRoute>>;
	try {
		route = await resolveRoute(settings, store, signal, preferredModel?.trim() || undefined);
	} catch (error) {
		if (!preferredModel?.trim()) throw error;
		route = await resolveRoute(settings, store, signal);
	}
	signal.throwIfAborted();
	const { kind, optionModel, ...connection } = route;
	const request = streamChat({
		...connection,
		messages: [{ role: "system", content: system }, { role: "user", content: user }],
		modelParams: optionsToParams(store.optionsFor(optionModel, kind)),
		maxTokens,
		maxRetries: 1,
		connectionTimeoutMs: 60_000,
		idleTimeoutMs: 30_000,
		signal,
	});
	let answer = "";
	try {
		while (true) {
			const next = await abortable(request.next(), signal);
			if (next.done) break;
			const event = next.value;
			if (event.type === "text-delta") answer += event.text;
			if (event.type === "tool-call" || event.type === "tool-call-start") {
				throw new Error("The model returned a tool call where plain documentation text was expected.");
			}
			if (event.type === "usage" && store.get().trackUsage) {
				void recordUsage(event.model ?? route.model, event.promptTokens, event.completionTokens, event).catch(() => { /* usage is best effort */ });
			}
		}
	} finally {
		void request.return(undefined).catch(() => { /* already finished */ });
	}
	return { text: stripReasoning(answer), model: route.model };
}

/** Explain why the catalog was rejected, including a short raw preview. */
function describeCatalogFailure(answer: string): string {
	const text = answer.trim();
	if (!text) return "! The model returned no text at all (the provider may have emitted only reasoning tokens).";
	const preview = text.replace(/\s+/g, " ").slice(0, 240);
	return `! Catalog preview: ${preview}${text.length > 240 ? "…" : ""}`;
}

/**
 * Catalog planning runs in the read-only tool loop so the model can inspect the
 * repository itself instead of trusting a precomputed listing.
 */
async function planCatalog(
	options: GenerateProjectDocsOptions,
	system: string,
	user: string,
	signal: AbortSignal,
	limits: DocsLimits,
): Promise<{ text: string; model: string }> {
	const route = await routeFor(options, options.featureStore.get().docsCatalogModel, signal);
	const { kind: _kind, optionModel: _optionModel, ...connection } = route;
	let answer = "";
	try {
		await runAgent({
			workspaceRoot: options.workspaceRoot,
			runId: `catalog-${Date.now()}`,
			apiBaseUrl: connection.apiBaseUrl,
			apiKey: connection.apiKey,
			apiKeyPool: connection.apiKeyPool,
			model: route.model,
			anthropic: connection.anthropic,
			oauthKind: connection.oauthKind,
			mode: "ask",
			prompt: user,
			history: [],
			maxSteps: limits.catalogSteps,
			maxTokens: MAX_CATALOG_TOKENS,
			enableFileReading: true,
			enableTerminalSuggestions: false,
			enableWorkspaceContext: false,
			enableWebSearch: false,
			enableWebFetch: false,
			systemPromptOverride: system,
			approve: async () => true,
			signal,
			emit: (event) => {
				if (event.type === "text-delta") answer += event.text;
				if (event.type === "tool-call-completed") log(`  ${event.name} ${event.status}`);
			},
		});
	} catch (error) {
		if (signal.aborted) throw error;
		log(`! Tool-driven catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	signal.throwIfAborted();
	const planned = stripReasoning(answer);
	if (planned.trim()) return { text: planned, model: route.model };
	// Chat-only providers cannot run the loop; fall back to a single completion.
	return complete(options.settingsManager, options.featureStore, signal, system, user, MAX_CATALOG_TOKENS, options.featureStore.get().docsCatalogModel);
}

/** Everything the writer needs: the verified brief plus the files the researcher read. */
interface PageEvidence {
	brief: string;
	excerpts: string;
}

function researchUserPayload(page: ProjectDocPage, language: UiLanguage): string {
	return JSON.stringify({
		language: SYSTEM_LANGUAGE[language],
		phase: "research",
		page: { title: page.title, description: page.description, sources: page.sources },
	});
}

function writeFirstPayload(page: ProjectDocPage, evidence: PageEvidence, language: UiLanguage): string {
	return JSON.stringify({
		language: SYSTEM_LANGUAGE[language],
		phase: "writing",
		part: 1,
		page: { title: page.title, description: page.description, sources: page.sources },
		researchBrief: evidence.brief,
		evidence: evidence.excerpts,
		instruction: "Write part 1 only: title, summary, Purpose and Scope, Overview and Architecture. Do not repeat the brief.",
	});
}

function writeContinuePayload(page: ProjectDocPage, evidence: PageEvidence, body: string, part: number, language: UiLanguage): string {
	const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim());
	return JSON.stringify({
		language: SYSTEM_LANGUAGE[language],
		phase: "writing",
		part,
		page: { title: page.title, description: page.description, sources: page.sources },
		researchBrief: evidence.brief,
		alreadyWritten: { characters: body.length, sections: headings },
		tail: body.slice(-2400),
		instruction: "Continue with the next sections only. Do not repeat earlier content. Add the completion sentinel on its own line when the whole page is done.",
	});
}

/**
 * Research phase: the read-only agent loop reads and greps the workspace, then
 * returns a verified brief. Read results are kept as evidence for the writer.
 */
async function researchPage(
	options: GenerateProjectDocsOptions,
	route: Awaited<ReturnType<typeof resolveRoute>>,
	page: ProjectDocPage,
	signal: AbortSignal,
): Promise<PageEvidence> {
	const { kind: _kind, optionModel: _optionModel, ...connection } = route;
	const settings = options.settingsManager.getSettings();
	let brief = "";
	const excerpts: string[] = [];
	let evidenceChars = 0;
	await runAgent({
		workspaceRoot: options.workspaceRoot,
		runId: `docs-${page.slug}-${Date.now()}`,
		apiBaseUrl: connection.apiBaseUrl,
		apiKey: connection.apiKey,
		apiKeyPool: connection.apiKeyPool,
		model: route.model,
		anthropic: connection.anthropic,
		oauthKind: connection.oauthKind,
		mode: "ask",
		prompt: researchUserPayload(page, options.language),
		history: [],
		maxSteps: MAX_RESEARCH_STEPS,
		maxTokens: settings.maxResponseLength > 0 ? Math.min(settings.maxResponseLength, 4096) : 4096,
		enableFileReading: true,
		enableTerminalSuggestions: false,
		enableWorkspaceContext: false,
		enableWebSearch: false,
		enableWebFetch: false,
		systemPromptOverride: await pageResearchSystemPrompt(),
		approve: async () => true,
		signal,
		emit: (event) => {
			if (event.type === "text-delta") {
				if (brief.length < MAX_BRIEF_CHARS) brief += event.text;
				return;
			}
			if (event.type !== "tool-call-completed" || event.name !== "Read" || event.status !== "completed") return;
			if (evidenceChars >= MAX_EVIDENCE_CHARS) return;
			const room = Math.min(MAX_EVIDENCE_FILE_CHARS, MAX_EVIDENCE_CHARS - evidenceChars);
			const text = event.result;
			if (!text || text.length < 40) return;
			const excerpt = text.length > room ? `${text.slice(0, room)}\n… (truncated)` : text;
			excerpts.push(excerpt);
			evidenceChars += excerpt.length;
		},
	});
	signal.throwIfAborted();
	return { brief: stripReasoning(brief).trim(), excerpts: excerpts.join("\n\n") };
}

/** Writing phase: append one model reply per round until the page is complete. */
async function writePageInParts(
	options: GenerateProjectDocsOptions,
	page: ProjectDocPage,
	evidence: PageEvidence,
	signal: AbortSignal,
): Promise<string> {
	const system = await pageWriteSystemPrompt();
	const preferredModel = options.featureStore.get().docsContentModel;
	let body = "";
	for (let part = 1; part <= MAX_WRITE_ROUNDS; part++) {
		signal.throwIfAborted();
		const reply = await complete(
			options.settingsManager,
			options.featureStore,
			signal,
			system,
			part === 1
				? writeFirstPayload(page, evidence, options.language)
				: writeContinuePayload(page, evidence, body, part, options.language),
			MAX_PAGE_TOKENS,
			preferredModel,
		);
		signal.throwIfAborted();
		let text = reply.text.trim();
		const finished = text.includes(PAGE_COMPLETE_SENTINEL);
		if (finished) text = text.split(PAGE_COMPLETE_SENTINEL).join("").trim();
		if (text) body = body ? `${body}\n\n${text}` : text;
		if (finished || !text) break;
		if (part > 1) log(`… ${page.title}: part ${part} (${body.length} chars)`);
	}
	return body.trim();
}

/** Regenerate the given pages with bounded concurrency; failures never abort the batch. */
async function generatePages(
	options: GenerateProjectDocsOptions,
	docsRoot: string,
	files: ScannedFile[],
	pages: ProjectDocPage[],
	signal: AbortSignal,
): Promise<{ generated: number; failed: number }> {
	let generated = 0;
	let failed = 0;
	let done = 0;
	publish({ phase: "pages", message: "", done: 0, total: pages.length, startedAt: status.startedAt ?? Date.now() });
	const route = await routeFor(options, options.featureStore.get().docsContentModel, signal);
	const queue = [...pages];
	const worker = async (): Promise<void> => {
		while (queue.length && !signal.aborted) {
			const page = queue.shift();
			if (!page) return;
			publish({ page: page.title });
			try {
				const selected = selectSourceFiles(page.sources, files);
				let evidence = { brief: "", excerpts: "" };
				try {
					log(`⋯ ${page.title}: researching`);
					evidence = await researchPage(options, route, page, signal);
				} catch (error) {
					if (signal.aborted) return;
					// Chat-only providers cannot run the tool loop; fall back to excerpts.
					log(`! ${page.title}: research unavailable (${error instanceof Error ? error.message : String(error)})`);
				}
				if (!evidence.excerpts && selected.length) {
					// The researcher produced only a brief; ground the writer in the real files.
					evidence = { brief: evidence.brief, excerpts: await readSourceExcerpts(options.workspaceRoot, selected) };
				}
				if (!evidence.brief && !evidence.excerpts) throw new Error("No readable files match this page's sources.");
				log(`⋯ ${page.title}: writing`);
				const body = await writePageInParts(options, page, evidence, signal);
				if (!body) throw new Error("The model returned an empty page.");
				await writePage(docsRoot, page.slug, body.startsWith("#") ? body : `# ${page.title}\n\n${body}`);
				generated++;
				log(`✓ ${page.title}`);
			} catch (error) {
				if (signal.aborted) return;
				failed++;
				log(`! ${page.title}: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				done++;
				publish({ done });
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pages.length) }, () => worker()));
	return { generated, failed };
}

async function saveManifest(
	root: string,
	pages: ProjectDocPage[],
	catalog: ProjectDocCatalogNode[] | undefined,
	model?: string,
	language?: UiLanguage,
): Promise<void> {
	const workspace = root;
	const manifest: ProjectDocsManifest = {
		version: 2,
		workspace,
		commit: await gitHead(root),
		model,
		generatedAt: Date.now(),
		language,
		catalog,
		pages,
	};
	await writeManifest(root, manifest);
}

/** Full or incremental generation of the project wiki. */
export async function generateProjectDocs(options: GenerateProjectDocsOptions): Promise<GenerateProjectDocsResult> {
	if (active) return { ok: false, error: "Documentation generation is already running.", generated: 0, failed: 0 };
	const root = projectDocsRoot(options.workspaceRoot);
	if (!root) return { ok: false, error: "Documentation storage is unavailable.", generated: 0, failed: 0 };
	const controller = new AbortController();
	const limits = docsLimits(options.featureStore.get());
	active = controller;
	await ensureDocSkills();
	const catalogPrompt = await catalogSystemPrompt();
	status = { phase: "idle", message: "", done: 0, total: 0, logs: [] };
	publish({ phase: "scanning", message: "", startedAt: Date.now(), finishedAt: undefined, error: undefined, page: undefined });
	try {
		log(`Scanning ${options.workspaceRoot}`);
		const files = await scanWorkspace(options.workspaceRoot, { maxFileBytes: limits.maxFileBytes });
		controller.signal.throwIfAborted();
		log(`${files.length} source files`);
		const previous = await readManifest(root);
		let pages: ProjectDocPage[];
		let targets: ProjectDocPage[];
		let catalogTree: ProjectDocCatalogNode[] | undefined = previous?.catalog;
		let model: string | undefined;

		if (options.only?.length) {
			if (!previous) throw new Error("Generate the documentation once before regenerating a single page.");
			const wanted = new Set(options.only);
			pages = previous.pages;
			targets = previous.pages.filter((page) => wanted.has(page.slug));
			if (!targets.length) throw new Error("No matching documentation page was found.");
			model = previous.model;
		} else if (options.mode === "incremental" && previous) {
			const changed = await changedSince(options.workspaceRoot, previous.commit);
			log(`${changed.length} changed files since ${previous.commit ?? "the last run"}`);
			pages = previous.pages;
			targets = affectedPages(previous.pages, changed);
			model = previous.model;
			if (!targets.length) {
				publish({ phase: "done", message: "", finishedAt: Date.now(), done: 0, total: 0 });
				log("Nothing to update.");
				return { ok: true, generated: 0, failed: 0 };
			}
			log(`${targets.length} pages need an update`);
		} else {
			publish({ phase: "catalog", message: "" });
			log("Planning the page catalog");
			const signals = await readCatalogSignals(options.workspaceRoot);
			const payload = catalogUserPayload(options.workspaceRoot, files, options.language, limits, signals);
			let response = await planCatalog(options, catalogPrompt, payload, controller.signal, limits);
			let planned = parseCatalogAnswer(response.text, limits.maxPages);
			if (!planned) {
				log(describeCatalogFailure(response.text));
				log("The catalog was not valid JSON; retrying once");
				response = await planCatalog(
					options,
					catalogPrompt,
					`${payload}\n\nThe previous answer was rejected. Return strictly valid JSON with no prose and no code fences. Verify the paths with the tools if needed.`,
					controller.signal,
					limits,
				);
				planned = parseCatalogAnswer(response.text, limits.maxPages);
			}
			if (!planned) {
				log(describeCatalogFailure(response.text));
				throw new Error("The model did not return a usable page catalog.");
			}
			pages = planned.pages;
			targets = pages;
			catalogTree = planned.catalog;
			model = response.model;
			log(`Planned ${pages.length} pages in ${catalogTree.length} domains`);
			await saveManifest(root, pages, catalogTree, model, options.language);
		}

		controller.signal.throwIfAborted();
		const { generated, failed } = await generatePages(options, root, files, targets, controller.signal);
		await saveManifest(root, pages, catalogTree, model, options.language);
		publish({ phase: "done", message: "", finishedAt: Date.now() });
		log(`Done: ${generated} generated, ${failed} failed`);
		return { ok: true, generated, failed };
	} catch (error) {
		if (controller.signal.aborted) {
			publish({ phase: "cancelled", finishedAt: Date.now() });
			log("Cancelled.");
			return { ok: false, cancelled: true, generated: 0, failed: 0 };
		}
		const message = error instanceof Error ? error.message : String(error);
		publish({ phase: "error", error: message, finishedAt: Date.now() });
		log(`Error: ${message}`);
		return { ok: false, error: message, generated: 0, failed: 0 };
	} finally {
		active = undefined;
	}
}

export interface GenerateMindMapOptions {
	workspaceRoot: string;
	settingsManager: SettingsManager;
	featureStore: FeatureStore;
	language: UiLanguage;
}

export interface GenerateMindMapResult {
	ok: boolean;
	cancelled?: boolean;
	error?: string;
	nodes?: number;
}

function mindmapUserPayload(root: string, files: ScannedFile[], language: UiLanguage, limits: DocsLimits, signals: string): string {
	return catalogUserPayload(root, files, language, limits, signals, "mindmap");
}

/** Keep only the heading lines the renderer understands (maximum three levels). */
export function parseMindMapAnswer(answer: string): string {
	const lines: string[] = [];
	for (const raw of stripReasoning(answer).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("```")) continue;
		const match = /^(#{1,3})\s+(.+)$/.exec(line);
		if (match) lines.push(`${match[1]} ${match[2].trim()}`);
	}
	return lines.join("\n");
}

/**
 * Architecture mind map: a read-only agent pass over the workspace that emits a
 * three-level `#` tree, stored as mindmap.md beside the manifest.
 */
export async function generateMindMap(options: GenerateMindMapOptions): Promise<GenerateMindMapResult> {
	if (active) return { ok: false, error: "Documentation generation is already running." };
	const root = projectDocsRoot(options.workspaceRoot);
	if (!root) return { ok: false, error: "Documentation storage is unavailable." };
	const controller = new AbortController();
	const limits = docsLimits(options.featureStore.get());
	active = controller;
	await ensureDocSkills();
	const system = await mindmapSystemPrompt();
	status = { phase: "idle", message: "", done: 0, total: 0, logs: [] };
	publish({ phase: "mindmap", message: "", startedAt: Date.now(), finishedAt: undefined, error: undefined, page: undefined });
	try {
		log(`Scanning ${options.workspaceRoot}`);
		const files = await scanWorkspace(options.workspaceRoot, { maxFileBytes: limits.maxFileBytes });
		controller.signal.throwIfAborted();
		log(`${files.length} source files`);
		const signals = await readCatalogSignals(options.workspaceRoot);
		const payload = mindmapUserPayload(options.workspaceRoot, files, options.language, limits, signals);
		const preferred = options.featureStore.get().docsCatalogModel;
		const route = await routeFor(options, preferred, controller.signal);
		const { kind: _kind, optionModel: _optionModel, ...connection } = route;
		let answer = "";
		try {
			await runAgent({
				workspaceRoot: options.workspaceRoot,
				runId: `mindmap-${Date.now()}`,
				apiBaseUrl: connection.apiBaseUrl,
				apiKey: connection.apiKey,
				apiKeyPool: connection.apiKeyPool,
				model: route.model,
				anthropic: connection.anthropic,
				oauthKind: connection.oauthKind,
				mode: "ask",
				prompt: payload,
				history: [],
				maxSteps: limits.mindmapSteps,
				maxTokens: limits.mindmapTokens,
				enableFileReading: true,
				enableTerminalSuggestions: false,
				enableWorkspaceContext: false,
				enableWebSearch: false,
				enableWebFetch: false,
				systemPromptOverride: system,
				approve: async () => true,
				signal: controller.signal,
				emit: (event) => {
					if (event.type === "text-delta") answer += event.text;
					if (event.type === "tool-call-completed") log(`  ${event.name} ${event.status}`);
				},
			});
		} catch (error) {
			if (controller.signal.aborted) throw error;
			log(`! Tool-driven mind map unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
		controller.signal.throwIfAborted();
		let text = parseMindMapAnswer(answer);
		if (!text) {
			// Chat-only providers cannot run the loop; fall back to a single completion.
			log("The tool loop returned no headings; retrying as a plain completion");
			const reply = await complete(
				options.settingsManager,
				options.featureStore,
				controller.signal,
				system,
				payload,
				limits.mindmapTokens,
				preferred,
			);
			text = parseMindMapAnswer(reply.text);
		}
		if (!text) throw new Error("The model did not return a usable mind map.");
		await writeMindMap(root, text);
		const nodes = text.split("\n").length;
		publish({ phase: "done", finishedAt: Date.now() });
		log(`Done: ${nodes} mind map nodes`);
		return { ok: true, nodes };
	} catch (error) {
		if (controller.signal.aborted) {
			publish({ phase: "cancelled", finishedAt: Date.now() });
			log("Cancelled.");
			return { ok: false, cancelled: true };
		}
		const message = error instanceof Error ? error.message : String(error);
		publish({ phase: "error", error: message, finishedAt: Date.now() });
		log(`Error: ${message}`);
		return { ok: false, error: message };
	} finally {
		active = undefined;
	}
}

/** Copy generated pages into `<workspace>/docs` so they can be committed. */
export async function exportProjectDocs(workspaceRoot: string): Promise<{ ok: boolean; error?: string; files?: number }> {
	const root = projectDocsRoot(workspaceRoot);
	if (!root) return { ok: false, error: "Documentation storage is unavailable." };
	let entries: string[];
	try {
		entries = await readdir(join(root, "pages"), { recursive: true });
	} catch {
		return { ok: false, error: "No generated pages yet." };
	}
	const target = join(workspaceRoot, "docs");
	await mkdir(target, { recursive: true });
	let copied = 0;
	for (const entry of entries) {
		if (!entry.toLowerCase().endsWith(".md")) continue;
		const destination = join(target, entry);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(join(root, "pages", entry), destination);
		copied++;
	}
	if (!copied) return { ok: false, error: "No generated pages yet." };
	return { ok: true, files: copied };
}

export interface TranslateProjectDocsOptions {
	workspaceRoot: string;
	settingsManager: SettingsManager;
	featureStore: FeatureStore;
	/** Language the current wiki was written in. */
	sourceLanguage: string;
	targetLanguage: UiLanguage;
}

export interface TranslateProjectDocsResult {
	ok: boolean;
	cancelled?: boolean;
	error?: string;
	translated: number;
	skipped: number;
	failed: number;
}

const MAX_TRANSLATE_CHARS = 12_000;
const TRANSLATE_CONCURRENCY = 2;

/** Translation lives where the wiki lives; language folders keep copies apart. */
export function projectDocsTranslationDir(workspaceRoot: string, language: string): string | undefined {
	const root = projectDocsRoot(workspaceRoot);
	return root ? translationDir(root, language) : undefined;
}

function languageName(language: string): string {
	return SYSTEM_LANGUAGE[language as UiLanguage] ?? language;
}

/** Task-model binding for translation, falling back to the content model. */
function translationModel(store: FeatureStore): string | undefined {
	const config = store.get();
	return config.docsTranslationModel?.trim() || config.docsContentModel?.trim() || undefined;
}

interface CatalogEntry {
	path: string;
	title: string;
	description?: string;
}

/** Every node needs a translated title; leaves also carry a description. */
function collectCatalogEntries(nodes: ProjectDocCatalogNode[], out: CatalogEntry[] = []): CatalogEntry[] {
	for (const node of nodes) {
		out.push({ path: node.path, title: node.title, ...(node.description ? { description: node.description } : {}) });
		collectCatalogEntries(node.children, out);
	}
	return out;
}

function parseTranslationItems(answer: string): Map<string, { title: string; description?: string }> | undefined {
	const text = stripReasoning(answer).trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	const candidate = fenced ? fenced[1] : text;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate.slice(start, end + 1));
	} catch {
		return undefined;
	}
	const items = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown> | null)?.items;
	if (!Array.isArray(items)) return undefined;
	const map = new Map<string, { title: string; description?: string }>();
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const entry = item as Record<string, unknown>;
		const path = typeof entry.path === "string" ? entry.path.trim() : "";
		const title = typeof entry.title === "string" ? entry.title.trim() : "";
		if (!path || !title) continue;
		const description = typeof entry.description === "string" ? entry.description.trim() : undefined;
		map.set(path, { title, description });
	}
	return map.size ? map : undefined;
}

function applyCatalogEntries(
	nodes: ProjectDocCatalogNode[],
	translated: Map<string, { title: string; description?: string }>,
): ProjectDocCatalogNode[] {
	return nodes.map((node) => {
		const hit = translated.get(node.path);
		const children = applyCatalogEntries(node.children, translated);
		if (!hit) return { ...node, children };
		return {
			...node,
			title: hit.title.slice(0, 160),
			description: hit.description ?? node.description,
			children,
		};
	});
}

/**
 * Split at heading boundaries outside code fences so no chunk cuts a fence in
 * half; a single oversized section stays whole rather than being mangled.
 */
export function splitMarkdownForTranslation(markdown: string, limit = MAX_TRANSLATE_CHARS): string[] {
	const lines = markdown.split("\n");
	const chunks: string[] = [];
	let current: string[] = [];
	let length = 0;
	let fence = false;
	const flush = (): void => {
		if (!current.length) return;
		chunks.push(current.join("\n"));
		current = [];
		length = 0;
	};
	for (const line of lines) {
		const heading = !fence && /^#{1,2}\s/.test(line);
		if (heading && length > 0 && length + line.length > limit) flush();
		current.push(line);
		length += line.length + 1;
		if (/^\s*```/.test(line)) fence = !fence;
	}
	flush();
	return chunks.length ? chunks : [markdown];
}

async function translateText(
	options: TranslateProjectDocsOptions,
	system: string,
	payload: string,
	maxTokens: number,
	signal: AbortSignal,
): Promise<string> {
	const reply = await complete(
		options.settingsManager,
		options.featureStore,
		signal,
		system,
		payload,
		maxTokens,
		translationModel(options.featureStore),
	);
	return reply.text.trim();
}

async function translateCatalog(
	options: TranslateProjectDocsOptions,
	system: string,
	entries: CatalogEntry[],
	signal: AbortSignal,
): Promise<Map<string, { title: string; description?: string }> | undefined> {
	const payload = JSON.stringify({ targetLanguage: languageName(options.targetLanguage), kind: "catalog", items: entries });
	return parseTranslationItems(await translateText(options, system, payload, MAX_CATALOG_TOKENS, signal));
}

async function translatePageBody(
	options: TranslateProjectDocsOptions,
	system: string,
	markdown: string,
	signal: AbortSignal,
): Promise<string> {
	const chunks = splitMarkdownForTranslation(markdown);
	const parts: string[] = [];
	for (const [index, chunk] of chunks.entries()) {
		signal.throwIfAborted();
		const payload = JSON.stringify({
			targetLanguage: languageName(options.targetLanguage),
			kind: "page",
			part: index + 1,
			totalParts: chunks.length,
			content: chunk,
		});
		const text = await translateText(options, system, payload, MAX_PAGE_TOKENS, signal);
		if (!text) throw new Error("The model returned an empty translation.");
		parts.push(text);
	}
	return parts.join("\n\n");
}

/**
 * Translate an existing wiki into another language. Catalog titles and page
 * bodies are translated separately; already translated pages of the same
 * source snapshot are skipped so the job is idempotent.
 */
export async function translateProjectDocs(options: TranslateProjectDocsOptions): Promise<TranslateProjectDocsResult> {
	const empty = { translated: 0, skipped: 0, failed: 0 };
	if (active) return { ok: false, error: "Documentation generation is already running.", ...empty };
	const root = projectDocsRoot(options.workspaceRoot);
	if (!root) return { ok: false, error: "Documentation storage is unavailable.", ...empty };
	if (options.sourceLanguage === options.targetLanguage) {
		return { ok: false, error: "The documentation is already in this language.", ...empty };
	}
	const source = await readManifest(root);
	if (!source) return { ok: false, error: "Generate the documentation before translating it.", ...empty };
	const dir = translationDir(root, options.targetLanguage);
	if (!dir) return { ok: false, error: "Unsupported target language.", ...empty };

	const controller = new AbortController();
	active = controller;
	await ensureDocSkills();
	status = { phase: "idle", message: "", done: 0, total: 0, logs: [] };
	publish({ phase: "translating", message: "", startedAt: Date.now(), finishedAt: undefined, error: undefined, page: undefined });
	let translated = 0;
	let skipped = 0;
	let failed = 0;
	let catalogReady = false;
	let catalog: ProjectDocCatalogNode[] | undefined = source.catalog;
	let pages: ProjectDocPage[] = source.pages.map((page) => ({ ...page }));
	const saveTranslation = async (): Promise<void> => {
		const manifest: ProjectDocsManifest = {
			version: 2,
			workspace: root,
			model: translationModel(options.featureStore),
			generatedAt: Date.now(),
			language: options.targetLanguage,
			sourceLanguage: options.sourceLanguage,
			sourceGeneratedAt: source.generatedAt,
			catalog: catalogReady ? catalog : undefined,
			pages,
		};
		await writeManifest(dir, manifest);
	};
	try {
		log(`Translating documentation into ${languageName(options.targetLanguage)}`);
		const system = await translationSystemPrompt();
		const previous = await readManifest(dir);
		const fresh = !!previous
			&& previous.sourceGeneratedAt === source.generatedAt
			&& previous.sourceLanguage === options.sourceLanguage;

		if (fresh && previous?.catalog?.length) {
			catalog = previous.catalog;
			pages = previous.pages.map((page) => ({ ...page }));
			catalogReady = true;
			log("Reusing the translated catalog");
		} else {
			const entries: CatalogEntry[] = catalog?.length
				? collectCatalogEntries(catalog)
				: source.pages.map((page) => ({ path: page.slug, title: page.title, description: page.description }));
			publish({ phase: "translating", message: "" });
			log(`Translating ${entries.length} titles`);
			const map = await translateCatalog(options, system, entries, controller.signal);
			controller.signal.throwIfAborted();
			if (map) {
				if (catalog?.length) catalog = applyCatalogEntries(catalog, map);
				pages = pages.map((page) => {
					const hit = map.get(page.slug);
					return hit ? { ...page, title: hit.title.slice(0, 160), description: hit.description ?? page.description } : page;
				});
				catalogReady = true;
			} else {
				log("! The catalog translation was rejected; page bodies are still translated");
			}
			await saveTranslation();
		}

		const queue: ProjectDocPage[] = [];
		for (const page of source.pages) {
			if (!existsSync(pageFilePath(root, page.slug) ?? "")) continue;
			if (fresh && existsSync(pageFilePath(dir, page.slug) ?? "")) {
				skipped++;
				continue;
			}
			queue.push(page);
		}
		publish({ phase: "translating", done: 0, total: queue.length, startedAt: status.startedAt ?? Date.now() });
		log(`${queue.length} pages to translate, ${skipped} already translated`);
		let done = 0;
		const worker = async (): Promise<void> => {
			while (queue.length && !controller.signal.aborted) {
				const page = queue.shift();
				if (!page) return;
				publish({ page: page.title });
				try {
					const markdown = await readPage(root, page.slug);
					if (!markdown) throw new Error("The source page is missing.");
					const body = await translatePageBody(options, system, markdown, controller.signal);
					await writePage(dir, page.slug, body);
					translated++;
					log(`✓ ${page.title}`);
				} catch (error) {
					if (controller.signal.aborted) return;
					failed++;
					log(`! ${page.title}: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					done++;
					publish({ done });
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(TRANSLATE_CONCURRENCY, queue.length) }, () => worker()));
		controller.signal.throwIfAborted();

		await saveTranslation();
		publish({ phase: "done", message: "", finishedAt: Date.now() });
		log(`Done: ${translated} translated, ${skipped} skipped, ${failed} failed`);
		return { ok: true, translated, skipped, failed };
	} catch (error) {
		// A failed or cancelled run keeps whatever finished so the next run can
		// skip translated pages, but never publishes a title-only manifest.
		if (catalogReady || translated > 0) {
			await saveTranslation().catch(() => { /* a failed save must not mask the error */ });
		}
		if (controller.signal.aborted) {
			publish({ phase: "cancelled", finishedAt: Date.now() });
			log("Cancelled.");
			return { ok: false, cancelled: true, translated, skipped, failed };
		}
		const message = error instanceof Error ? error.message : String(error);
		publish({ phase: "error", error: message, finishedAt: Date.now() });
		log(`Error: ${message}`);
		return { ok: false, error: message, translated, skipped, failed };
	} finally {
		active = undefined;
	}
}

