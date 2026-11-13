/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("vscode", () => ({}));
import { parseCodeGraph, readCodeGraph, renderCodeGraphContext } from "./codeGraph";

const temporary: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "awh-codegraph-"));
	temporary.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseCodeGraph", () => {
	it("normalises array-shaped nodes and edges", () => {
		const graph = parseCodeGraph({
			nodes: [
				{ id: "a", label: "loop.ts", type: "file", source_file: "src/agent/loop.ts" },
				{ name: "turn", kind: "function", path: "src/agent/turn.ts" },
			],
			edges: [
				{ source: "a", target: "turn", label: "imports" },
				{ from: "a", to: "missing" },
				{ from: "a", to: "a" },
			],
		});
		expect(graph).toBeDefined();
		expect(graph?.nodes).toEqual([
			{ id: "a", label: "loop.ts", kind: "file", file: "src/agent/loop.ts", group: undefined },
			{ id: "turn", label: "turn", kind: "function", file: "src/agent/turn.ts", group: undefined },
		]);
		expect(graph?.edges).toEqual([
			{ from: "a", to: "turn", kind: "imports" },
			{ from: "a", to: "missing", kind: undefined },
		]);
	});

	it("accepts id-keyed node maps", () => {
		const graph = parseCodeGraph({ nodes: { "n1": { label: "index.ts" } }, edges: [] });
		expect(graph?.nodes[0]).toMatchObject({ id: "n1", label: "index.ts" });
	});

	it("rejects payloads without nodes", () => {
		expect(parseCodeGraph({ edges: [] })).toBeUndefined();
		expect(parseCodeGraph(undefined)).toBeUndefined();
	});
});

describe("renderCodeGraphContext", () => {
	it("summarises areas, entry points and hubs", () => {
		const graph = parseCodeGraph({
			nodes: [
				{ id: "a", label: "src/agent/loop.ts", type: "file", source_file: "src/agent/loop.ts" },
				{ id: "b", label: "src/agent/codeGraph.ts", type: "file", source_file: "src/agent/codeGraph.ts" },
				{ id: "c", label: "src/ui/extension.ts", type: "file", source_file: "src/ui/extension.ts" },
			],
			edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }],
		})!;
		const text = renderCodeGraphContext(graph);
		expect(text.startsWith("<code_graph>")).toBe(true);
		expect(text).toContain("src/agent (2 nodes)");
		expect(text).toContain("src/ui/extension.ts");
		expect(text).toContain("degree 2");
	});

	it("stays inside the character budget", () => {
		const nodes = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, label: `src/dir${i % 10}/file${i}.ts`, type: "file", source_file: `src/dir${i % 10}/file${i}.ts` }));
		const edges = nodes.slice(1).map((node, i) => ({ from: nodes[i].id, to: node.id }));
		const text = renderCodeGraphContext(parseCodeGraph({ nodes, edges })!, 400);
		expect(text.length).toBeLessThanOrEqual(400);
		expect(text.endsWith("(truncated)")).toBe(true);
	});
});

describe("readCodeGraph", () => {
	it("reads graphify artifacts from .docs and keeps metadata", async () => {
		const workspace = tempDir();
		mkdirSync(join(workspace, ".docs", "graphify-out"), { recursive: true });
		writeFileSync(join(workspace, ".docs", "graphify-out", "graph.json"), JSON.stringify({
			nodes: [{ id: "a", label: "a.ts", source_file: "src/a.ts" }],
			edges: [],
			metadata: { tool: "graphify", schema: 1, generated_at: "2026-01-02T03:04:05.000Z", commit: "abc123" },
		}));
		const graph = await readCodeGraph(workspace);
		expect(graph?.nodes).toHaveLength(1);
		expect(graph?.metadata?.commit).toBe("abc123");
		expect(graph?.generatedAt).toBe("2026-01-02T03:04:05.000Z");
	});

	it("returns nothing when the graph is absent", async () => {
		expect(await readCodeGraph(tempDir())).toBeUndefined();
	});
});
