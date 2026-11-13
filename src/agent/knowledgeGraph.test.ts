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
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("vscode", () => ({}));
import { knowledgeGraphArtifacts } from "./knowledgeGraph";

const temporary: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "awh-graph-"));
	temporary.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("knowledgeGraphArtifacts", () => {
	it("writes into .docs inside the workspace", () => {
		const workspace = tempDir();
		const artifacts = knowledgeGraphArtifacts(workspace);
		expect(artifacts).toBeDefined();
		expect(artifacts?.directory).toBe(join(workspace, ".docs", "graphify-out"));
		expect(artifacts?.json.endsWith("graph.json")).toBe(true);
		expect(artifacts?.html.endsWith("graph.html")).toBe(true);
		expect(artifacts?.report.endsWith("GRAPH_REPORT.md")).toBe(true);
	});

	it("returns nothing without a workspace folder", () => {
		expect(knowledgeGraphArtifacts("")).toBeUndefined();
	});
});
