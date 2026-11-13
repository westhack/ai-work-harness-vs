/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { stripReasoning } from "../../shared/reasoning";

/** One documentation page. `sources` are workspace-relative glob patterns. */
export interface ProjectDocPage {
	group: string;
	title: string;
	slug: string;
	description: string;
	sources: string[];
}

/**
 * Navigation tree, mirroring the reference catalog shape: parents only group,
 * leaves carry the content metadata.
 */
export interface ProjectDocCatalogNode {
	title: string;
	path: string;
	order: number;
	children: ProjectDocCatalogNode[];
	description?: string;
	sources?: string[];
}

/** Both the navigation tree and its flattened leaves. */
export interface ProjectDocCatalog {
	catalog: ProjectDocCatalogNode[];
	pages: ProjectDocPage[];
}

/** Everything needed to reopen a generated wiki without re-scanning the repo. */
export interface ProjectDocsManifest {
	version: 1 | 2;
	workspace: string;
	commit?: string;
	model?: string;
	generatedAt: number;
	/** Language the pages were written in; older manifests have no value. */
	language?: string;
	/** Set on translation manifests: the language the source pages were written in. */
	sourceLanguage?: string;
	/** Set on translation manifests: `generatedAt` of the translated source snapshot. */
	sourceGeneratedAt?: number;
	/** Present from version 2 on; older manifests fall back to `pages`. */
	catalog?: ProjectDocCatalogNode[];
	pages: ProjectDocPage[];
}

let storageRoot: string | undefined;

/** Project docs live beside the other extension caches, never in the repo. */
export function setProjectDocsStorageDir(dir: string): void {
	storageRoot = dir;
}

export function getProjectDocsStorageDir(): string | undefined {
	return storageRoot;
}

/** Stable folder per workspace so two repos never share a manifest. */
export function workspaceKey(workspaceRoot: string): string {
	const normalized = resolve(workspaceRoot).replace(/\\/g, "/").toLowerCase();
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function projectDocsRoot(workspaceRoot: string): string | undefined {
	if (!storageRoot) return undefined;
	return join(storageRoot, "project-docs", workspaceKey(workspaceRoot));
}

/**
 * Graphify writes inside the repository under `.docs`, so the artifacts stay
 * with the workspace and can be ignored like any other local cache.
 */
export function graphOutputRoot(workspaceRoot: string): string | undefined {
	if (!workspaceRoot?.trim()) return undefined;
	return join(workspaceRoot, ".docs");
}

/**
 * Translated wikis live beside the source wiki, one folder per language, and
 * reuse the manifest/page helpers so both variants share the same layout.
 */
export function translationDir(root: string, language: string): string | undefined {
	const safe = safeSlug(language);
	if (!safe) return undefined;
	return join(root, "i18n", safe);
}

/** Page slugs become file names, so keep them to a conservative character set. */
export function safeSlug(slug: string): string | undefined {
	const cleaned = slug.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!cleaned || cleaned.length > 120) return undefined;
	if (cleaned.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(cleaned)) return undefined;
	return cleaned;
}

/** Page paths are flat file names: dots are allowed, slashes are not. */
export function safeDocPath(path: string): string | undefined {
	const safe = safeSlug(path);
	if (!safe || safe.includes("/")) return undefined;
	return safe.toLowerCase();
}

/** Resolve a page file, refusing anything that escapes the pages folder. */
export function pageFilePath(dir: string, slug: string): string | undefined {
	const safe = safeDocPath(slug);
	if (!safe) return undefined;
	const pages = join(dir, "pages");
	const file = join(pages, `${safe}.md`);
	const normalized = resolve(file);
	if (!normalized.startsWith(resolve(pages) + sep)) return undefined;
	return normalized;
}

export async function readManifest(dir: string): Promise<ProjectDocsManifest | undefined> {
	try {
		const raw = await readFile(join(dir, "manifest.json"), "utf8");
		const parsed = JSON.parse(raw) as ProjectDocsManifest;
		if (!parsed || (parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.pages)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export async function writeManifest(dir: string, manifest: ProjectDocsManifest): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

export async function readPage(dir: string, slug: string): Promise<string | undefined> {
	const file = pageFilePath(dir, slug);
	if (!file || !existsSync(file)) return undefined;
	return readFile(file, "utf8");
}

export async function writePage(dir: string, slug: string, markdown: string): Promise<void> {
	const file = pageFilePath(dir, slug);
	if (!file) throw new Error(`Invalid documentation page name: ${slug}`);
	await mkdir(join(dir, "pages"), { recursive: true });
	await writeFile(file, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
}

/** The architecture mind map lives beside the manifest, not inside pages/. */
export function mindmapPath(dir: string): string {
	return join(dir, "mindmap.md");
}

export async function readMindMap(dir: string): Promise<string | undefined> {
	const file = mindmapPath(dir);
	if (!existsSync(file)) return undefined;
	return readFile(file, "utf8");
}

export async function writeMindMap(dir: string, markdown: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(mindmapPath(dir), markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
}

/**
 * Validate the model-produced catalog tree. Parents only group; leaves carry
 * content metadata and become pages. Invalid nodes are dropped, never guessed.
 */
export function normalizeCatalog(value: unknown, limit = 60): ProjectDocCatalog {
	const empty: ProjectDocCatalog = { catalog: [], pages: [] };
	const root = Array.isArray(value)
		? value
		: value && typeof value === "object"
			? (value as Record<string, unknown>).items ?? (value as Record<string, unknown>).pages
			: undefined;
	if (!Array.isArray(root)) return empty;
	const pages: ProjectDocPage[] = [];
	const used = new Set<string>();

	const walk = (items: unknown[], ancestors: string[], depth: number, inherited: string[]): ProjectDocCatalogNode[] => {
		const nodes: ProjectDocCatalogNode[] = [];
		items.forEach((item, index) => {
			if (pages.length >= limit || depth > 2) return;
			if (!item || typeof item !== "object") return;
			const entry = item as Record<string, unknown>;
			const title = firstString(entry.title, entry.name, entry.heading);
			if (!title) return;
			const path = safeDocPath(firstString(entry.path, entry.slug, entry.id)) ?? slugFromTitle(title);
			if (!path || used.has(path)) return;
			const order = typeof entry.order === "number" && Number.isFinite(entry.order) ? entry.order : index;
			const ownSources = readSources(entry.sources);
			const sources = ownSources.length ? ownSources : inherited;
			const children = walk(
				Array.isArray(entry.children) ? entry.children : [],
				[...ancestors, title],
				depth + 1,
				sources,
			);
			if (children.length) {
				used.add(path);
				nodes.push({ title: title.slice(0, 120), path, order, children });
				return;
			}
			// A leaf without any source material cannot be written; drop it.
			if (!sources.length) return;
			used.add(path);
			const description = firstString(entry.description, entry.summary).slice(0, 400) || title;
			nodes.push({ title: title.slice(0, 120), path, order, children: [], description, sources });
			pages.push({
				group: ancestors.join(" / ") || "Overview",
				title: title.slice(0, 120),
				slug: path,
				description,
				sources,
			});
		});
		return nodes.sort((a, b) => a.order - b.order);
	};

	return { catalog: walk(root, [], 0, []), pages };
}

/** Models occasionally emit `sources` as one comma-separated string. */
function readSources(value: unknown): string[] {
	const list = Array.isArray(value)
		? value
		: typeof value === "string" ? value.split(/[,\n]/) : [];
	return list
		.filter((source): source is string => typeof source === "string" && !!source.trim())
		.map((source) => source.trim().replace(/\\/g, "/"))
		.filter((source) => !source.includes(".."))
		.slice(0, 24);
}

function firstString(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

/** ASCII titles become stable slugs; anything else falls back to the title hash. */
function slugFromTitle(title: string): string {
	const ascii = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
	if (ascii.length >= 2) return ascii;
	return `page-${createHash("sha1").update(title).digest("hex").slice(0, 8)}`;
}

/** Pull a catalog tree out of a model answer, tolerating prose and code fences. */
export function parseCatalogAnswer(answer: string, limit = 60): ProjectDocCatalog | undefined {
	const text = stripReasoning(answer).trim();
	if (!text) return undefined;
	const candidates = [
		...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim()),
		text,
	];
	const start = text.search(/[[{]/);
	const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
	if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
	for (const candidate of candidates) {
		let parsed: unknown;
		try { parsed = JSON.parse(candidate); } catch { continue; }
		const direct = normalizeCatalog(parsed, limit);
		if (direct.pages.length) return direct;
		// Some models wrap the tree one level deeper, e.g. {"catalog":{"items":[...]}}.
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			for (const value of Object.values(parsed as Record<string, unknown>)) {
				if (!value || typeof value !== "object") continue;
				const nested = normalizeCatalog(value, limit);
				if (nested.pages.length) return nested;
			}
		}
	}
	return undefined;
}
