/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { readFile, stat } from "node:fs/promises";
import { knowledgeGraphArtifacts, readGraphMetadata, readHeadCommit, type GraphMetadata } from "./knowledgeGraph";

/** Flattened graphify node, normalised across graph.json schema variants. */
export interface CodeGraphNode {
	id: string;
	label: string;
	kind?: string;
	file?: string;
	group?: string;
}

export interface CodeGraphEdge {
	from: string;
	to: string;
	kind?: string;
}

export interface CodeGraph {
	nodes: CodeGraphNode[];
	edges: CodeGraphEdge[];
	metadata?: GraphMetadata;
	generatedAt: string;
}

interface CacheEntry {
	mtimeMs: number;
	graph?: CodeGraph;
}

const cache = new Map<string, CacheEntry>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstText(entry: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = text(entry[key]);
		if (value) return value;
	}
	return undefined;
}

/** graph.json lists nodes either as an array or as an id-keyed object. */
function readEntries(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.map(asRecord).filter((entry): entry is Record<string, unknown> => !!entry);
	const map = asRecord(value);
	if (!map) return [];
	return Object.entries(map)
		.map(([key, item]) => {
			const entry = asRecord(item);
			return entry ? { id: key, ...entry } : { id: key, label: key };
		});
}

function looksLikePath(value: string): boolean {
	return /[\\/]/.test(value) || /\.[a-z0-9]{1,6}$/i.test(value);
}

function normalizeNode(entry: Record<string, unknown>): CodeGraphNode | undefined {
	const id = firstText(entry, ["id", "node_id", "key", "uid"]) ?? firstText(entry, ["label", "name", "title", "path"]);
	if (!id) return undefined;
	const label = firstText(entry, ["label", "name", "title", "path"]) ?? id;
	const file = firstText(entry, ["source_file", "file", "path", "file_path", "source"]);
	return {
		id,
		label,
		kind: firstText(entry, ["type", "kind", "category"]),
		file: file && looksLikePath(file) ? file.replace(/\\/g, "/") : undefined,
		group: firstText(entry, ["group", "module", "community", "cluster"]),
	};
}

function normalizeEdge(entry: Record<string, unknown>): CodeGraphEdge | undefined {
	const from = firstText(entry, ["from", "source", "src", "start"]);
	const to = firstText(entry, ["to", "target", "dst", "end"]);
	if (!from || !to || from === to) return undefined;
	return { from, to, kind: firstText(entry, ["label", "relation", "type", "kind"]) };
}

export function parseCodeGraph(value: unknown, generatedAt = new Date().toISOString()): CodeGraph | undefined {
	const root = asRecord(value);
	if (!root) return undefined;
	const nodes: CodeGraphNode[] = [];
	const seen = new Set<string>();
	readEntries(root.nodes).forEach((entry) => {
		const node = normalizeNode(entry);
		if (!node || seen.has(node.id)) return;
		seen.add(node.id);
		nodes.push(node);
	});
	const edges: CodeGraphEdge[] = [];
	for (const entry of readEntries(root.edges)) {
		const edge = normalizeEdge(entry);
		if (edge) edges.push(edge);
	}
	if (!nodes.length) return undefined;
	const meta = asRecord(root.metadata);
	const metadata: GraphMetadata | undefined = meta && typeof meta.generated_at === "string"
		? {
			tool: typeof meta.tool === "string" ? meta.tool : "graphify",
			schema: typeof meta.schema === "number" ? meta.schema : 1,
			generated_at: meta.generated_at,
			tool_version: typeof meta.tool_version === "string" ? meta.tool_version : undefined,
			commit: typeof meta.commit === "string" ? meta.commit : undefined,
		}
		: undefined;
	return { nodes, edges, metadata, generatedAt: metadata?.generated_at ?? generatedAt };
}

/** Read `.docs/graphify-out/graph.json`, caching by mtime. */
export async function readCodeGraph(workspaceRoot: string): Promise<CodeGraph | undefined> {
	const artifacts = knowledgeGraphArtifacts(workspaceRoot);
	if (!artifacts) return undefined;
	let mtimeMs: number;
	try {
		mtimeMs = (await stat(artifacts.json)).mtimeMs;
	} catch {
		cache.delete(artifacts.json);
		return undefined;
	}
	const cached = cache.get(artifacts.json);
	if (cached && cached.mtimeMs === mtimeMs) return cached.graph;
	let graph: CodeGraph | undefined;
	try {
		graph = parseCodeGraph(JSON.parse(await readFile(artifacts.json, "utf8")));
	} catch {
		graph = undefined;
	}
	cache.set(artifacts.json, { mtimeMs, graph });
	return graph;
}

/** Drop the cached parse so the next read observes a rebuilt graph. */
export function invalidateCodeGraph(workspaceRoot: string): void {
	const artifacts = knowledgeGraphArtifacts(workspaceRoot);
	if (artifacts) cache.delete(artifacts.json);
}

function degreeMap(graph: CodeGraph): Map<string, number> {
	const degree = new Map<string, number>();
	for (const edge of graph.edges) {
		degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
		degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
	}
	return degree;
}

function topDirectories(graph: CodeGraph, limit: number): { path: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const node of graph.nodes) {
		if (!node.file) continue;
		const parts = node.file.split("/");
		const dir = parts.length > 2 ? parts.slice(0, 2).join("/") : parts.slice(0, -1).join("/");
		if (!dir) continue;
		counts.set(dir, (counts.get(dir) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([path, count]) => ({ path, count }));
}

function entryPoints(graph: CodeGraph, limit: number): string[] {
	const files = new Set<string>();
	for (const node of graph.nodes) {
		if (!node.file) continue;
		if (/^(index|main|app|extension|server|cli|mod)\.[cm]?[jt]sx?$/i.test(node.file.split("/").pop() ?? "")) files.add(node.file);
	}
	return [...files].slice(0, limit);
}

function kindCounts(graph: CodeGraph, limit: number): { kind: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const node of graph.nodes) {
		if (!node.kind) continue;
		counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([kind, count]) => ({ kind, count }));
}

function truncate(lines: string[], budget: number): string {
	const text = lines.join("\n");
	if (text.length <= budget) return text;
	return `${text.slice(0, Math.max(0, budget - 20)).trimEnd()}\n... (truncated)`;
}

/**
 * Bounded prompt block describing the repository structure. The agent reads
 * this instead of walking the tree on every question.
 */
export function renderCodeGraphContext(graph: CodeGraph, budget = 6000): string {
	const degree = degreeMap(graph);
	const hubs = graph.nodes
		.map((node) => ({ node, degree: degree.get(node.id) ?? 0 }))
		.filter((item) => item.degree > 1)
		.sort((a, b) => b.degree - a.degree)
		.slice(0, 12);
	const dirs = topDirectories(graph, 12);
	const entries = entryPoints(graph, 6);
	const kinds = kindCounts(graph, 8);
	const meta = graph.metadata;
	const lines = [
		"<code_graph>",
		`source: graphify (${graph.nodes.length} nodes, ${graph.edges.length} edges)`,
		meta?.commit ? `commit: ${meta.commit.slice(0, 12)}` : "",
		`generated_at: ${graph.generatedAt}`,
		"This is a cached structural map of the repository. Prefer it over re-reading the whole tree; use the CodeGraph tool for details.",
		"",
		"Largest areas:",
		...dirs.map((item) => `- ${item.path} (${item.count} nodes)`),
		"",
		"Entry points:",
		entries.length ? entries.map((file) => `- ${file}`).join("\n") : "- (none detected)",
		"",
		"Most connected nodes:",
		...hubs.map((item) => `- ${item.node.label}${item.node.file && item.node.file !== item.node.label ? ` [${item.node.file}]` : ""} (degree ${item.degree}${item.node.kind ? `, ${item.node.kind}` : ""})`),
		"",
		"Node kinds:",
		...kinds.map((item) => `- ${item.kind}: ${item.count}`),
		"</code_graph>",
	];
	return truncate(lines.filter((line, index) => line !== "" || lines[index - 1] !== ""), budget);
}

/** Injection entry point for the chat loop; returns nothing when no graph exists. */
export async function codeGraphPromptBlock(workspaceRoot: string | undefined, budget = 6000): Promise<string | undefined> {
	if (!workspaceRoot) return undefined;
	const graph = await readCodeGraph(workspaceRoot);
	if (!graph) return undefined;
	return renderCodeGraphContext(graph, budget);
}

/** Compact status shown in Settings and the status-bar tooltip. */
export interface CodeGraphSummary {
	available: boolean;
	nodes: number;
	edges: number;
	generatedAt?: string;
	commit?: string;
	toolVersion?: string;
	stale: boolean;
}

export async function codeGraphSummary(workspaceRoot: string): Promise<CodeGraphSummary> {
	const graph = await readCodeGraph(workspaceRoot);
	if (!graph) return { available: false, nodes: 0, edges: 0, stale: false };
	const metadata = await readGraphMetadata(workspaceRoot);
	const head = await readHeadCommit(workspaceRoot);
	return {
		available: true,
		nodes: graph.nodes.length,
		edges: graph.edges.length,
		generatedAt: graph.generatedAt,
		commit: metadata?.commit,
		toolVersion: metadata?.tool_version,
		stale: !!metadata?.commit && !!head && metadata.commit !== head,
	};
}

/** True when the graph was built from a different commit than HEAD. */
export async function codeGraphNeedsRefresh(workspaceRoot: string): Promise<boolean> {
	const artifacts = knowledgeGraphArtifacts(workspaceRoot);
	if (!artifacts) return false;
	const metadata = await readGraphMetadata(workspaceRoot);
	if (!metadata) return true;
	const head = await readHeadCommit(workspaceRoot);
	// Without commit information on either side the graph cannot be judged stale.
	if (!head || !metadata.commit) return false;
	return head !== metadata.commit;
}

function matchNodes(graph: CodeGraph, query: string, limit: number): CodeGraphNode[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const exactly: CodeGraphNode[] = [];
	const partial: CodeGraphNode[] = [];
	for (const node of graph.nodes) {
		const haystacks = [node.label, node.id, node.file ?? ""].map((value) => value.toLowerCase());
		if (haystacks.some((value) => value === needle)) exactly.push(node);
		else if (haystacks.some((value) => value.includes(needle))) partial.push(node);
		if (exactly.length >= limit) break;
	}
	return [...exactly, ...partial].slice(0, limit);
}

/** `overview` / `find` / `neighbors` results, always rendered as bounded text. */
export async function queryCodeGraph(
	workspaceRoot: string,
	action: "overview" | "find" | "neighbors",
	value?: string,
	limit = 20,
): Promise<string> {
	const graph = await readCodeGraph(workspaceRoot);
	if (!graph) {
		return "No code graph is available yet. Ask the user to build it from Settings > Knowledge base, or run the graphify build command.";
	}
	if (action === "overview") return renderCodeGraphContext(graph, 8000);
	const query = (value ?? "").trim();
	if (!query) return "The query parameter is required for find and neighbors.";
	if (action === "find") {
		const matches = matchNodes(graph, query, Math.min(Math.max(limit, 1), 50));
		if (!matches.length) return `No nodes matched "${query}".`;
		const degree = degreeMap(graph);
		return matches
			.map((node) => `${node.label}${node.kind ? ` (${node.kind})` : ""}${node.file && node.file !== node.label ? ` — ${node.file}` : ""} — degree ${degree.get(node.id) ?? 0}`)
			.join("\n");
	}
	const seeds = matchNodes(graph, query, 5);
	if (!seeds.length) return `No nodes matched "${query}".`;
	const byId = new Map(graph.nodes.map((node) => [node.id, node]));
	const lines: string[] = [];
	for (const seed of seeds) {
		lines.push(`${seed.label}:`);
		const outgoing = graph.edges.filter((edge) => edge.from === seed.id).slice(0, 25);
		const incoming = graph.edges.filter((edge) => edge.to === seed.id).slice(0, 25);
		for (const edge of outgoing) {
			const target = byId.get(edge.to);
			lines.push(`  -> ${target?.label ?? edge.to}${edge.kind ? ` (${edge.kind})` : ""}`);
		}
		for (const edge of incoming) {
			const source = byId.get(edge.from);
			lines.push(`  <- ${source?.label ?? edge.from}${edge.kind ? ` (${edge.kind})` : ""}`);
		}
		if (!outgoing.length && !incoming.length) lines.push("  (no edges)");
	}
	return truncate(lines, 8000);
}
