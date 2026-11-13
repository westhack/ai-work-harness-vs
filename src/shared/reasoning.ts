/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Some providers stream reasoning models that inline the chain of thought in
 * the answer text as `<think>…</think>` instead of a separate reasoning field.
 * Documentation, translation and JSON contracts must never keep it, so remove
 * complete blocks, a truncated unclosed block and stray tags.
 */
const BLOCK = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
const UNCLOSED = /<think(?:ing)?>[\s\S]*$/i;
const STRAY = /<\/?think(?:ing)?>/gi;

export function stripReasoning(text: string): string {
	if (!text || !/<\/?think/i.test(text)) return text;
	return text.replace(BLOCK, "").replace(UNCLOSED, "").replace(STRAY, "").trim();
}
