/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { defineTool } from "./types";
import { findWorkspaceRoot } from "../../context/workspaceUtils";
import {
	addMemory,
	deleteMemory,
	listAllMemory,
	searchMemory,
	updateMemory,
	type MemoryEntry,
	type MemoryScope,
} from "../../stores/memoryStore";

const WRITE_ACTIONS = new Set(["add", "update", "delete"]);
const WRITE_BLOCKED_MODES = new Set(["ask", "plan", "multitask", "project"]);

function formatEntry(entry: MemoryEntry): string {
	const tags = entry.tags.length ? ` (tags: ${entry.tags.join(", ")})` : "";
	return `- ${entry.id} [${entry.scope}] ${entry.text}${tags}`;
}

function scopeOf(value: unknown): MemoryScope | undefined {
	return value === "global" || value === "project" ? value : undefined;
}

export const memoryTool = defineTool("Memory", false, async (input, _signal, _id, ctx) => {
	const action = String(input?.action ?? "").trim().toLowerCase();
	const mode = ctx?.getMode?.();
	if (WRITE_ACTIONS.has(action) && mode && WRITE_BLOCKED_MODES.has(mode)) {
		return { output: "error: memory writes are available in agent and debug modes only" };
	}
	const root = findWorkspaceRoot();
	try {
		switch (action) {
			case "add": {
				const entry = await addMemory(
					{
						text: String(input?.text ?? ""),
						tags: Array.isArray(input?.tags) ? input.tags.map(String) : undefined,
						scope: scopeOf(input?.scope),
					},
					root,
				);
				return { output: `Saved memory ${entry.id} [${entry.scope}]: ${entry.text}` };
			}
			case "search": {
				const entries = await searchMemory(String(input?.query ?? ""), root, 50);
				return { output: entries.length ? entries.map(formatEntry).join("\n") : "No matching memories." };
			}
			case "list": {
				const entries = await listAllMemory(root);
				return { output: entries.length ? entries.map(formatEntry).join("\n") : "No saved memories." };
			}
			case "update": {
				if (!input?.id) return { output: "error: id is required" };
				const entry = await updateMemory(
					String(input.id),
					{
						text: input.text === undefined ? undefined : String(input.text),
						tags: Array.isArray(input.tags) ? input.tags.map(String) : undefined,
					},
					root,
				);
				return { output: entry ? `Updated memory ${entry.id}: ${entry.text}` : "error: memory not found" };
			}
			case "delete": {
				if (!input?.id) return { output: "error: id is required" };
				const deleted = await deleteMemory(String(input.id), root);
				return { output: deleted ? `Deleted memory ${input.id}.` : "error: memory not found" };
			}
			default:
				return { output: "error: action must be one of add, search, list, update, delete" };
		}
	} catch (error) {
		return { output: `error: ${(error as Error)?.message || error}` };
	}
});
