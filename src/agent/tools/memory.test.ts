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
import { memoryTool } from "./memory";

const scope = vi.hoisted(() => ({ root: "" }));

vi.mock("vscode", () => ({ workspace: { workspaceFolders: undefined } }));
vi.mock("../../context/workspaceUtils", () => ({ findWorkspaceRoot: () => scope.root }));

beforeEach(async () => {
	scope.root = await fs.mkdtemp(path.join(os.tmpdir(), "awh-memory-tool-"));
});

afterEach(async () => {
	await fs.rm(scope.root, { recursive: true, force: true });
});

const run = (input: Record<string, unknown>, mode?: string) =>
	memoryTool.execute(input, undefined, undefined, mode ? { todos: [], getMode: () => mode as never } : { todos: [] });

describe("Memory tool", () => {
	it("adds, lists, updates and deletes a memory", async () => {
		const added = await run({ action: "add", text: "Always run tests with vitest", tags: ["testing"] }, "agent");
		expect(added.output).toContain("Saved memory");

		const listed = await run({ action: "list" });
		expect(listed.output).toContain("Always run tests with vitest");
		const id = listed.output.match(/^- (\S+)/m)?.[1];

		const updated = await run({ action: "update", id, text: "Always run tests with pnpm vitest" }, "agent");
		expect(updated.output).toContain("Updated memory");

		const searched = await run({ action: "search", query: "vitest" });
		expect(searched.output).toContain("pnpm vitest");

		const removed = await run({ action: "delete", id }, "agent");
		expect(removed.output).toContain("Deleted memory");
		expect((await run({ action: "list" })).output).toContain("No saved memories");
	});

	it("blocks writes in read-only and coordinator modes", async () => {
		for (const mode of ["ask", "plan", "multitask", "project"]) {
			const result = await run({ action: "add", text: "should not persist" }, mode);
			expect(result.output).toContain("agent and debug modes only");
		}
		expect((await run({ action: "list" })).output).toContain("No saved memories");
	});

	it("rejects unknown actions and missing ids", async () => {
		expect((await run({ action: "remove" })).output).toContain("action must be one of");
		expect((await run({ action: "delete" })).output).toContain("id is required");
		expect((await run({ action: "update", id: "missing", text: "x" })).output).toContain("not found");
	});
});
