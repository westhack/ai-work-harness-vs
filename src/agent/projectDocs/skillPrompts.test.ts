/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	catalogSystemPrompt,
	docSkillPath,
	ensureDocSkills,
	loadDocSkillBody,
	pageResearchSystemPrompt,
	pageWriteSystemPrompt,
	resetDocSkills,
} from "./skillPrompts";
import { CATALOG_SKILL, PAGE_SKILL } from "./prompts";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "awh-doc-skills-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("doc skills", () => {
	it("writes both SKILL.md files with frontmatter", async () => {
		await ensureDocSkills(root);
		const catalog = await readFile(docSkillPath("deepwiki-catalog", root), "utf8");
		expect(catalog.startsWith("---\nname: deepwiki-catalog\n")).toBe(true);
		expect(catalog).toContain(CATALOG_SKILL.trim());
		const page = await readFile(docSkillPath("deepwiki-page", root), "utf8");
		expect(page).toContain(PAGE_SKILL.trim());
	});

	it("never overwrites an edited skill", async () => {
		await ensureDocSkills(root);
		const file = docSkillPath("deepwiki-page", root);
		await writeFile(file, "---\nname: deepwiki-page\n---\n\nCUSTOM RULES\n", "utf8");
		await ensureDocSkills(root);
		expect(await readFile(file, "utf8")).toContain("CUSTOM RULES");
	});

	it("returns the skill body without frontmatter", async () => {
		await ensureDocSkills(root);
		const body = await loadDocSkillBody("deepwiki-catalog", root);
		expect(body?.startsWith("# Wiki Catalog Generator")).toBe(true);
		expect(body).not.toContain("name: deepwiki-catalog");
	});

	it("falls back to the bundled prompt when the skill is missing", async () => {
		const research = await pageResearchSystemPrompt(root);
		expect(research).toContain("NEVER FABRICATE CODE");
		expect(research).toContain("<research_contract>");
		const write = await pageWriteSystemPrompt(root);
		expect(write).toContain("<write_contract>");
		expect(write).toContain("[[DOC_COMPLETE]]");
	});

	it("appends the machine contract after a user-edited body", async () => {
		await ensureDocSkills(root);
		const file = docSkillPath("deepwiki-catalog", root);
		await writeFile(file, "---\nname: deepwiki-catalog\n---\n\nONLY MY RULES\n", "utf8");
		const prompt = await catalogSystemPrompt(root);
		expect(prompt.startsWith("ONLY MY RULES")).toBe(true);
		expect(prompt).toContain("<output_schema>");
		expect(prompt).toContain('"path"');
	});

	it("restores the defaults after edits", async () => {
		await ensureDocSkills(root);
		const file = docSkillPath("deepwiki-page", root);
		await writeFile(file, "damaged", "utf8");
		await resetDocSkills(root);
		expect(await readFile(file, "utf8")).toContain("NEVER FABRICATE CODE");
	});
});
