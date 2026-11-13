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
import { afterEach, describe, expect, it } from "vitest";
import { affectedPages, matchesSource, readSourceExcerpts, scanWorkspace, selectSourceFiles } from "./scan";

const temporary: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "awh-scan-"));
	temporary.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, path: string, content = "export const value = 1;\n"): void {
	const file = join(root, ...path.split("/"));
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, content, "utf8");
}

describe("matchesSource", () => {
	it("matches globs with and without a directory", () => {
		expect(matchesSource("src/**/*.ts", "src/agent/loop.ts")).toBe(true);
		expect(matchesSource("src/**/*.ts", "src/loop.ts")).toBe(true);
		expect(matchesSource("src/**/*.ts", "webview-ui/main.tsx")).toBe(false);
		expect(matchesSource("*.md", "README.md")).toBe(true);
		expect(matchesSource("*.md", "docs/setup.md")).toBe(true);
	});

	it("normalises windows separators and leading ./", () => {
		expect(matchesSource(".\\src\\agent\\*.ts", "src/agent/loop.ts")).toBe(true);
		expect(matchesSource("./package.json", "package.json")).toBe(true);
	});

	it("ignores empty patterns", () => {
		expect(matchesSource("  ", "src/a.ts")).toBe(false);
	});
});

describe("scanWorkspace", () => {
	it("keeps every text file and skips binaries, secrets, caches and dot folders", async () => {
		const root = tempDir();
		write(root, "src/agent/loop.ts");
		write(root, "src/agent/deep/state.ts");
		write(root, "README.md");
		write(root, "package-lock.json", "{}");
		write(root, "pom.xml", "<project/>");
		write(root, "conf/app.properties", "a=b");
		write(root, "Dockerfile", "FROM node");
		write(root, "node_modules/pkg/index.js");
		write(root, ".git/config");
		write(root, "credentials.json", "{}");
		write(root, "logo.png", "binary");

		const files = await scanWorkspace(root);
		const paths = files.map((file) => file.path).sort();
		expect(paths).toEqual([
			"Dockerfile",
			"README.md",
			"conf/app.properties",
			"package-lock.json",
			"pom.xml",
			"src/agent/deep/state.ts",
			"src/agent/loop.ts",
		]);
	});

	it("honours the file cap", async () => {
		const root = tempDir();
		for (let index = 0; index < 5; index++) write(root, `src/file-${index}.ts`);
		expect(await scanWorkspace(root, { maxFiles: 2 })).toHaveLength(2);
	});
});

describe("selectSourceFiles", () => {
	it("deduplicates files matched by several patterns", () => {
		const files = [
			{ path: "src/a.ts", size: 10 },
			{ path: "src/b.ts", size: 10 },
			{ path: "docs/a.md", size: 10 },
		];
		const selected = selectSourceFiles(["src/**", "src/a.ts"], files, 10);
		expect(selected.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("stops at the requested limit", () => {
		const files = [{ path: "src/a.ts", size: 1 }, { path: "src/b.ts", size: 1 }, { path: "src/c.ts", size: 1 }];
		expect(selectSourceFiles(["src/**"], files, 2)).toHaveLength(2);
	});
});

describe("readSourceExcerpts", () => {
	it("labels excerpts with their path and truncates long files", async () => {
		const root = tempDir();
		write(root, "src/big.ts", "x".repeat(200));
		const excerpts = await readSourceExcerpts(root, [{ path: "src/big.ts", size: 200 }], 1000, 50);
		expect(excerpts).toContain("--- src/big.ts ---");
		expect(excerpts).toContain("truncated");
		expect(excerpts.length).toBeLessThan(200);
	});
});

describe("affectedPages", () => {
	const pages = [
		{ group: "Overview", title: "Agent", slug: "agent", description: "d", sources: ["src/agent/**"] },
		{ group: "Overview", title: "UI", slug: "ui", description: "d", sources: ["webview-ui/**"] },
	];

	it("selects pages whose sources match a changed file", () => {
		expect(affectedPages(pages, ["src/agent/loop.ts"]).map((page) => page.slug)).toEqual(["agent"]);
		expect(affectedPages(pages, ["src/agent/loop.ts", "webview-ui/main.tsx"]).map((page) => page.slug)).toEqual(["agent", "ui"]);
	});

	it("returns nothing when no file changed", () => {
		expect(affectedPages(pages, [])).toEqual([]);
		expect(affectedPages(pages, ["README.md"])).toEqual([]);
	});
});
