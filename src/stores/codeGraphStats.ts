/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import { workspaceKey } from "../agent/projectDocs/store";

/** Local, per-workspace counters that make the code graph's usage visible. */
export interface CodeGraphStats {
	builds: number;
	buildFailures: number;
	lastBuildAt?: number;
	injections: number;
	injectedChars: number;
	toolCalls: number;
	lastUsedAt?: number;
}

export type CodeGraphEvent =
	| { type: "build"; ok: boolean }
	| { type: "inject"; chars: number }
	| { type: "toolCall" };

const KEY = "aiworkharness.codeGraphStats";
let ctx: vscode.ExtensionContext | undefined;
let writes: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

export function initCodeGraphStats(context: vscode.ExtensionContext): void {
	ctx = context;
}

function emptyStats(): CodeGraphStats {
	return { builds: 0, buildFailures: 0, injections: 0, injectedChars: 0, toolCalls: 0 };
}

export function getCodeGraphStats(workspaceRoot: string): CodeGraphStats {
	const all = ctx?.globalState.get<Record<string, CodeGraphStats>>(KEY) ?? {};
	return { ...emptyStats(), ...all[workspaceKey(workspaceRoot)] };
}

/** Push committed changes so an open settings panel can refresh. */
export function onCodeGraphStatsChanged(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/** Fire-and-forget counters: callers may ignore the promise; failures stay silent. */
export function recordCodeGraphEvent(workspaceRoot: string, event: CodeGraphEvent): Promise<void> {
	if (!workspaceRoot) return Promise.resolve();
	const key = workspaceKey(workspaceRoot);
	writes = writes.catch(() => {}).then(async () => {
		if (!ctx) return;
		const all = { ...(ctx.globalState.get<Record<string, CodeGraphStats>>(KEY) ?? {}) };
		const stats = { ...emptyStats(), ...all[key] };
		if (event.type === "build") {
			if (event.ok) {
				stats.builds += 1;
				stats.lastBuildAt = Date.now();
			} else {
				stats.buildFailures += 1;
			}
		} else if (event.type === "inject") {
			stats.injections += 1;
			stats.injectedChars += Math.max(0, event.chars);
			stats.lastUsedAt = Date.now();
		} else {
			stats.toolCalls += 1;
			stats.lastUsedAt = Date.now();
		}
		all[key] = stats;
		await ctx.globalState.update(KEY, all);
		for (const listener of listeners) {
			try { listener(); } catch { /* a disposed panel must not stop the write */ }
		}
	});
	return writes;
}
