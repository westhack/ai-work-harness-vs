/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { AgentEvent } from "../types";

/** Selectable agent engines: the built-in loop plus external CLI adapters. */
export type EngineId = "builtin" | "claude-code" | "opencode" | "dsh"
	| "gemini" | "qwen" | "kimi" | "crush" | "zcode" | "pi" | "codex";

/** One condensed transcript message handed to an external engine. */
export interface EngineHistoryMessage {
	role: "user" | "assistant";
	text: string;
}

/** Everything an external engine needs to drive one turn end-to-end. */
export interface EngineRuntime {
	workspaceRoot: string;
	prompt: string;
	/** Condensed recent transcript (user/assistant text only). */
	history: EngineHistoryMessage[];
	mode: string;
	runId: string;
	signal: AbortSignal;
	emit: (e: AgentEvent) => void;
	/** AiWorkHarness's approval policy, folded to a plain boolean. */
	approve: (toolName: string, input: any, callId?: string) => Promise<boolean>;
	/** Drain user steering queued while the run is in flight. */
	drainSteering: () => Promise<string[]>;
	onAfterEdit?: (path: string) => void;
}

/** An adapter that lets an external CLI drive a full agent turn. */
export interface AgentEngine {
	id: EngineId;
	/** i18n key or proper noun shown in the settings UI. */
	label: string;
	experimental?: boolean;
	available(): Promise<{ ok: boolean; detail?: string }>;
	run(rt: EngineRuntime): Promise<{ text: string; sessionId?: string }>;
}
