/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	normalizeCatalog,
	pageFilePath,
	parseCatalogAnswer,
	projectDocsRoot,
	readManifest,
	readPage,
	safeDocPath,
	safeSlug,
	setProjectDocsStorageDir,
	writeManifest,
	writePage,
} from "./store";

const temporary: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "awh-docs-"));
	temporary.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("safeSlug", () => {
	it("accepts namespaced slugs", () => {
		expect(safeSlug("overview")).toBe("overview");
		expect(safeSlug("module/agent-engine")).toBe("module/agent-engine");
	});

	it("rejects traversal and characters that break file names", () => {
		expect(safeSlug("../secrets")).toBeUndefined();
		expect(safeSlug("a/../../b")).toBeUndefined();
		expect(safeSlug("has space")).toBeUndefined();
		expect(safeSlug("")).toBeUndefined();
		expect(safeSlug("/absolute")).toBe("absolute");
	});
});

describe("safeDocPath", () => {
	it("accepts flat lowercase page names with dots", () => {
		expect(safeDocPath("Overview")).toBe("overview");
		expect(safeDocPath("agent-engine.tool-calling")).toBe("agent-engine.tool-calling");
	});

	it("rejects nested paths and traversal", () => {
		expect(safeDocPath("module/setup")).toBeUndefined();
		expect(safeDocPath("../escape")).toBeUndefined();
		expect(safeDocPath("has space")).toBeUndefined();
	});
});

describe("pageFilePath", () => {
	it("keeps pages inside the pages folder", () => {
		const dir = tempDir();
		const file = pageFilePath(dir, "setup");
		expect(file?.startsWith(join(dir, "pages"))).toBe(true);
		expect(pageFilePath(dir, "../escape")).toBeUndefined();
		expect(pageFilePath(dir, "module/setup")).toBeUndefined();
	});
});

describe("normalizeCatalog", () => {
	it("builds a tree and flattens only the leaves into pages", () => {
		const result = normalizeCatalog({
			items: [
				{
					title: "Architecture",
					path: "architecture",
					order: 0,
					children: [
						{ title: "Agent Engine", path: "agent-engine", order: 0, description: "d", sources: ["src/agent/**"] },
						{ title: "UI Layer", path: "ui-layer", order: 1, description: "d", sources: ["src/ui/**"] },
					],
				},
				{ title: "Overview", path: "overview", order: 1, description: "d", sources: ["README.md"] },
			],
		});
		expect(result.catalog).toHaveLength(2);
		expect(result.catalog[0].children).toHaveLength(2);
		expect(result.catalog[0].children[0].children).toEqual([]);
		expect(result.pages.map((page) => page.slug)).toEqual(["agent-engine", "ui-layer", "overview"]);
		expect(result.pages[0].group).toBe("Architecture");
	});

	it("drops duplicate paths and leaves without sources", () => {
		const result = normalizeCatalog({
			items: [
				{ title: "One", path: "dup", description: "d", sources: ["src/**"] },
				{ title: "Two", path: "dup", description: "d", sources: ["src/**"] },
				{ title: "No sources", path: "empty", description: "d", sources: [] },
			],
		});
		expect(result.pages.map((page) => page.slug)).toEqual(["dup"]);
	});

	it("derives slugs, descriptions and splits string sources", () => {
		const result = normalizeCatalog({
			items: [{ title: "项目总览", sources: "src/**, package.json" }],
		});
		expect(result.pages).toHaveLength(1);
		expect(result.pages[0].slug.startsWith("page-")).toBe(true);
		expect(result.pages[0].description).toBe("项目总览");
		expect(result.pages[0].sources).toEqual(["src/**", "package.json"]);
	});

	it("caps the leaves at the requested limit", () => {
		const result = normalizeCatalog({
			items: Array.from({ length: 12 }, (_, index) => ({
				title: `Page ${index}`,
				path: `page-${index}`,
				description: "d",
				sources: ["src/**"],
			})),
		}, 5);
		expect(result.pages).toHaveLength(5);
	});

	it("inherits parent sources for source-less children", () => {
		const result = normalizeCatalog({
			items: [{ title: "Domain", path: "domain", sources: ["src/agent/**"], children: [{ title: "Child", path: "child", description: "d" }] }],
		});
		expect(result.pages.map((page) => page.slug)).toEqual(["child"]);
		expect(result.pages[0].sources).toEqual(["src/agent/**"]);
	});

	it("ignores malformed payloads", () => {
		expect(normalizeCatalog(null).pages).toEqual([]);
		expect(normalizeCatalog({ items: "nope" }).pages).toEqual([]);
	});
});

describe("parseCatalogAnswer", () => {
	const json = JSON.stringify({ items: [{ title: "Overview", path: "overview", description: "d", sources: ["src/**"] }] });

	it("accepts bare JSON", () => {
		expect(parseCatalogAnswer(json)?.pages[0].slug).toBe("overview");
	});

	it("accepts JSON inside code fences with prose around it", () => {
		expect(parseCatalogAnswer(`Here is the plan:\n\`\`\`json\n${json}\n\`\`\`\nDone.`)?.pages[0].slug).toBe("overview");
	});

	it("accepts a top-level item array and a nested catalog wrapper", () => {
		expect(parseCatalogAnswer(JSON.stringify([{ title: "Overview", path: "overview", sources: ["src/**"] }]))?.pages[0].title).toBe("Overview");
		expect(parseCatalogAnswer(JSON.stringify({ catalog: { items: [{ title: "Overview", path: "overview", sources: ["src/**"] }] } }))?.pages).toHaveLength(1);
	});

	it("rejects answers without usable pages", () => {
		expect(parseCatalogAnswer("I cannot help with that.")).toBeUndefined();
		expect(parseCatalogAnswer("")).toBeUndefined();
	});
});

describe("page and manifest storage", () => {
	it("round-trips pages with a trailing newline", async () => {
		const dir = tempDir();
		await writePage(dir, "overview", "# Overview");
		expect(await readPage(dir, "overview")).toBe("# Overview\n");
		expect(await readPage(dir, "missing")).toBeUndefined();
	});

	it("round-trips the manifest", async () => {
		const dir = tempDir();
		await writeManifest(dir, {
			version: 1,
			workspace: "h:/repo",
			commit: "abc1234",
			generatedAt: 42,
			pages: [{ group: "Overview", title: "Overview", slug: "overview", description: "d", sources: ["src/**"] }],
		});
		const manifest = await readManifest(dir);
		expect(manifest?.commit).toBe("abc1234");
		expect(manifest?.pages).toHaveLength(1);
	});

	it("ignores a corrupt manifest", async () => {
		const dir = tempDir();
		await writePage(dir, "overview", "# Overview");
		expect(await readManifest(dir)).toBeUndefined();
	});
});

describe("storage root", () => {
	it("derives a stable per-workspace folder", () => {
		const storage = tempDir();
		setProjectDocsStorageDir(storage);
		const first = projectDocsRoot("H:\\program\\OpenCursor");
		const second = projectDocsRoot("h:/program/opencursor");
		expect(first).toBeDefined();
		expect(first).toBe(second);
		expect(first?.startsWith(join(storage, "project-docs"))).toBe(true);
		setProjectDocsStorageDir("");
		expect(projectDocsRoot("H:\\program\\OpenCursor")).toBeUndefined();
	});
});
