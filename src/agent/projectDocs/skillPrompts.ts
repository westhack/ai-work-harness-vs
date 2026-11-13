/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	CATALOG_CONTRACT,
	CATALOG_SKILL,
	DOC_SKILLS,
	MINDMAP_CONTRACT,
	MINDMAP_SKILL,
	PAGE_RESEARCH_CONTRACT,
	PAGE_SKILL,
	PAGE_WRITE_CONTRACT,
	TRANSLATION_CONTRACT,
	TRANSLATION_SKILL,
	renderSkillFile,
	type DocSkillId,
} from "./prompts";

/** Skills live where the Rules & Skills list already looks for user skills. */
export function docSkillsRoot(home: string = homedir()): string {
	return join(home, ".aiworkharness", "skills");
}

export function docSkillPath(id: DocSkillId, root: string = docSkillsRoot()): string {
	return join(root, id, "SKILL.md");
}

/** Write the default skills once; existing files are never overwritten. */
export async function ensureDocSkills(root: string = docSkillsRoot()): Promise<void> {
	for (const id of Object.keys(DOC_SKILLS) as DocSkillId[]) {
		const file = docSkillPath(id, root);
		try {
			await readFile(file, "utf8");
			continue;
		} catch {
			// Missing file: fall through and write the default.
		}
		await mkdir(join(root, id), { recursive: true });
		await writeFile(file, renderSkillFile(id), "utf8");
	}
}

/** Restore both skills to the bundled defaults. */
export async function resetDocSkills(root: string = docSkillsRoot()): Promise<void> {
	for (const id of Object.keys(DOC_SKILLS) as DocSkillId[]) {
		await mkdir(join(root, id), { recursive: true });
		await writeFile(docSkillPath(id, root), renderSkillFile(id), "utf8");
	}
}

/** Skill body without frontmatter, or undefined when unreadable or empty. */
export async function loadDocSkillBody(id: DocSkillId, root: string = docSkillsRoot()): Promise<string | undefined> {
	let raw: string;
	try {
		raw = await readFile(docSkillPath(id, root), "utf8");
	} catch {
		return undefined;
	}
	const stripped = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
	return stripped || undefined;
}

/** System prompt for the catalog planner: user skill body plus the JSON contract. */
export async function catalogSystemPrompt(root: string = docSkillsRoot()): Promise<string> {
	const body = await loadDocSkillBody("deepwiki-catalog", root) ?? CATALOG_SKILL;
	return `${body}\n\n${CATALOG_CONTRACT}`;
}

/** System prompt for the tool-driven research phase. */
export async function pageResearchSystemPrompt(root: string = docSkillsRoot()): Promise<string> {
	const body = await loadDocSkillBody("deepwiki-page", root) ?? PAGE_SKILL;
	return `${body}\n\n${PAGE_RESEARCH_CONTRACT}`;
}

/** System prompt for each incremental writing round. */
export async function pageWriteSystemPrompt(root: string = docSkillsRoot()): Promise<string> {
	const body = await loadDocSkillBody("deepwiki-page", root) ?? PAGE_SKILL;
	return `${body}\n\n${PAGE_WRITE_CONTRACT}`;
}

/** System prompt for translating the catalog and page bodies. */
export async function translationSystemPrompt(root: string = docSkillsRoot()): Promise<string> {
	const body = await loadDocSkillBody("deepwiki-translation", root) ?? TRANSLATION_SKILL;
	return `${body}\n\n${TRANSLATION_CONTRACT}`;
}

/** System prompt for the architecture mind map. */
export async function mindmapSystemPrompt(root: string = docSkillsRoot()): Promise<string> {
	const body = await loadDocSkillBody("deepwiki-mindmap", root) ?? MINDMAP_SKILL;
	return `${body}\n\n${MINDMAP_CONTRACT}`;
}
