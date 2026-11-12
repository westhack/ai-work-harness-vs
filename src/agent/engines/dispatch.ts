/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as path from "node:path";
import type { AgentEvent, Step } from "../types";
import { getEngine } from "./registry";
import { collectChangedNow, computeExternalChanges, takeExternalChangeSnapshot, type TrackedChange } from "./changeTracking";
import type { ChangeOwner } from "../../stores/pendingChanges";
import type { EngineHistoryMessage, EngineId, EngineRuntime } from "./types";

export type { EngineId } from "./types";

const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARS = 8_000;

/**
 * Condense the transcript for an external engine: keep user/assistant text
 * only (loop-injected synthetic messages and tool results are host-internal),
 * clip to the most recent 20 messages and 8k characters each.
 */
export function compressHistory(history: Step[]): EngineHistoryMessage[] {
	const messages: EngineHistoryMessage[] = [];
	for (const step of history) {
		if (step.kind === "user") {
			if (step.synthetic) continue;
			if (step.text.trim()) messages.push({ role: "user", text: step.text });
		} else if (step.kind === "assistant") {
			if (step.text.trim()) messages.push({ role: "assistant", text: step.text });
		}
	}
	return messages.slice(-MAX_HISTORY_MESSAGES).map((message) => ({
		role: message.role,
		text: message.text.length > MAX_HISTORY_CHARS ? `${message.text.slice(0, MAX_HISTORY_CHARS)}…` : message.text,
	}));
}

/**
 * One text payload for stateless adapters (fresh session per turn): the
 * condensed transcript rides in front of the new request.
 */
export function buildPromptWithHistory(history: EngineHistoryMessage[], prompt: string): string {
	if (!history.length) return prompt;
	const transcript = history.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`).join("\n");
	return `Previous conversation summary:\n${transcript}\n\nCurrent request:\n${prompt}`;
}

/** What the host hands over for one externally-driven turn. */
export interface ExternalEngineRun {
	workspaceRoot: string;
	/** Owning chat for pending-change records registered by this run. */
	conversationId?: string;
	prompt: string;
	history: Step[];
	mode: string;
	runId: string;
	signal: AbortSignal;
	emit: (e: AgentEvent) => void;
	approve: (toolName: string, input: any, callId?: string) => Promise<boolean | { approved: false; blockedSubject: string }>;
	drainSteering: () => Promise<string[]>;
	onAfterEdit?: (path: string) => void;
	/**
	 * Register the file changes the external engine made with its own tools
	 * during this turn into the host's pending-changes store, so the chat's
	 * "changed files" bar and Keep/Undo All cover them too.
	 */
	registerChanges?: (owner: ChangeOwner, records: TrackedChange[]) => Promise<void>;
}

/** Input fields external engines use to carry a target file path. */
const INPUT_PATH_FIELDS = ["file_path", "path", "notebook_path", "filePath"] as const;

function noteFilePath(root: string, raw: unknown, into: Set<string>): void {
	if (typeof raw !== "string" || !raw.trim()) return;
	const candidate = path.resolve(root, raw);
	const rel = path.relative(root, candidate);
	if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;
	into.add(candidate);
}

function noteInputPaths(root: string, input: unknown, into: Set<string>): void {
	if (!input || typeof input !== "object") return;
	const record = input as Record<string, unknown>;
	let hasPathField = false;
	for (const field of INPUT_PATH_FIELDS) {
		if (typeof record[field] === "string") { noteFilePath(root, record[field], into); hasPathField = true; }
	}
	if (hasPathField) return;
	// Codex file_change items carry their paths as the keys of a {path: {kind}} map.
	const values = Object.values(record);
	if (values.length > 0 && values.every((value) => {
		return value !== null && typeof value === "object" && typeof (value as Record<string, unknown>)["kind"] === "string";
	})) {
		for (const key of Object.keys(record)) noteFilePath(root, key, into);
	}
}

/**
 * Run one turn through an external engine adapter. Emits run-status running
 * and (on success) finished; failures propagate to the caller's existing
 * runAgent error path so error toasts and run-status error are not duplicated.
 */
export async function runExternalEngine(engineId: EngineId, run: ExternalEngineRun): Promise<void> {
	const engine = getEngine(engineId);
	if (!engine) throw new Error(`Unknown agent engine: ${engineId}`);
	const availability = await engine.available();
	if (!availability.ok) throw new Error(availability.detail ?? `Agent engine ${engineId} is not available`);

	// File paths the engine's tools mention scope which post-run changes are
	// attributed to this turn (all of them when no file was ever named).
	const touchedPaths = new Set<string>();
	const emit = (event: AgentEvent): void => {
		if (event.type === "tool-call-started") noteInputPaths(run.workspaceRoot, event.input, touchedPaths);
		run.emit(event);
	};

	// Fold the host's approval union ({approved:false,…} → denied) to a boolean.
	const approve = async (toolName: string, input: unknown, callId?: string): Promise<boolean> => {
		const lowered = toolName.toLowerCase();
		if (lowered.includes("edit") || lowered.includes("write")) {
			noteFilePath(run.workspaceRoot, input && typeof input === "object" ? (input as Record<string, unknown>)["path"] : undefined, touchedPaths);
		}
		const decision = await run.approve(toolName, input, callId);
		return typeof decision === "object" && decision !== null ? false : decision === true;
	};

	const runtime: EngineRuntime = {
		workspaceRoot: run.workspaceRoot,
		prompt: run.prompt,
		history: compressHistory(run.history),
		mode: run.mode,
		runId: run.runId,
		signal: run.signal,
		emit,
		approve,
		drainSteering: run.drainSteering,
		onAfterEdit: run.onAfterEdit,
	};

	// Snapshot before the engine starts so its writes can be turned into
	// pending-change records; outside a git repository tracking is skipped.
	const snapshot = run.registerChanges ? await takeExternalChangeSnapshot(run.workspaceRoot) : null;
	run.emit({ type: "run-status", status: "running" });
	try {
		await engine.run(runtime);
	} finally {
		// Record externally-made changes even when the engine fails or is cancelled.
		if (snapshot && run.registerChanges) {
			try {
				const changedNow = await collectChangedNow(run.workspaceRoot);
				const records = await computeExternalChanges(run.workspaceRoot, snapshot, [...touchedPaths], changedNow);
				if (records.length) await run.registerChanges({ conversationId: run.conversationId ?? "", runId: run.runId }, records);
			} catch { /* change tracking must never break the engine run */ }
		}
	}
	if (run.signal.aborted) return; // the host reports cancellation from the signal
	run.emit({ type: "run-status", status: "finished" });
}
