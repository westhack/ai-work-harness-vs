/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addMemory, clearMemory, deleteMemory, listAllMemory, listMemory, memoryFilePath, renderMemoryBlock, searchMemory, updateMemory } from "./memoryStore";

vi.mock("vscode", () => ({ workspace: { workspaceFolders: undefined } }));

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "awh-memory-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("memoryStore", () => {
	it("stores project entries in the workspace file", async () => {
		const entry = await addMemory({ text: "Prefer pnpm over npm", tags: ["tools"] }, root);
		expect(entry.scope).toBe("project");
		expect(entry.tags).toEqual(["tools"]);
		const file = memoryFilePath("project", root);
		expect(file).toBeTruthy();
		const body = JSON.parse(await fs.readFile(file!, "utf8"));
		expect(body.version).toBe(1);
		expect(body.entries).toHaveLength(1);
		expect(body.entries[0].text).toBe("Prefer pnpm over npm");
	});

	it("deduplicates identical text within a scope", async () => {
		const first = await addMemory({ text: "Use tabs in this repo", tags: ["style"] }, root);
		const second = await addMemory({ text: "  use   TABS in this repo ", tags: ["indent"] }, root);
		expect(second.id).toBe(first.id);
		expect(second.tags).toEqual(["style", "indent"]);
		expect(await listMemory("project", root)).toHaveLength(1);
	});

	it("updates, deletes and clears entries", async () => {
		const entry = await addMemory({ text: "Deploy on Fridays", tags: ["ops"] }, root);
		const updated = await updateMemory(entry.id, { text: "Never deploy on Fridays", tags: ["release"] }, root);
		expect(updated?.text).toBe("Never deploy on Fridays");
		expect(updated?.tags).toEqual(["release"]);

		expect(await deleteMemory(entry.id, root)).toBe(true);
		expect(await deleteMemory(entry.id, root)).toBe(false);
		expect(await listMemory("project", root)).toHaveLength(0);

		await addMemory({ text: "One" }, root);
		await addMemory({ text: "Two" }, root);
		expect(await clearMemory("project", root)).toBe(2);
		expect(await listMemory("project", root)).toHaveLength(0);
	});

	it("treats a malformed file as empty", async () => {
		const file = memoryFilePath("project", root)!;
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, "{not json", "utf8");
		expect(await listAllMemory(root)).toHaveLength(0);
		await addMemory({ text: "Recovered" }, root);
		expect(await listMemory("project", root)).toHaveLength(1);
	});

	it("rejects empty and oversized text", async () => {
		await expect(addMemory({ text: "   " }, root)).rejects.toThrow("required");
		await expect(addMemory({ text: "x".repeat(2001) }, root)).rejects.toThrow("2000");
	});

	it("ranks relevant entries first and bounds the prompt block", async () => {
		await addMemory({ text: "This project uses pnpm workspaces", tags: ["pnpm"] }, root);
		await addMemory({ text: "The user prefers concise answers" }, root);
		const block = await renderMemoryBlock({ root, query: "how do I install pnpm packages?" });
		expect(block).toContain("<memory>");
		expect(block.indexOf("pnpm workspaces")).toBeLessThan(block.indexOf("concise answers"));
		expect(block).toContain("Memory tool");

		const bounded = await renderMemoryBlock({ root, limit: 1, maxChars: 200 });
		expect(bounded.split("\n").filter((line) => line.startsWith("- [")).length).toBe(1);
	});

	it("searches by keyword and falls back to newest first", async () => {
		await addMemory({ text: "Alpha deployment checklist" }, root);
		await addMemory({ text: "Beta preferences" }, root);
		const hits = await searchMemory("deployment", root);
		expect(hits[0].text).toContain("Alpha");
		const all = await searchMemory("", root);
		expect(all).toHaveLength(2);
	});
});
