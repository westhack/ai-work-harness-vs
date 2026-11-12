/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// Role enums — fixed per format. Pure data (no logic).
// OpenAI chat / Claude share these; mapping between them stays in translators.
export const ROLE: Record<string, string> = {
    USER: "user",
    ASSISTANT: "assistant",
    TOOL: "tool",
    SYSTEM: "system",
    DEVELOPER: "developer",
};
// Gemini / Antigravity use "model" instead of "assistant".
export const GEMINI_ROLE: Record<string, string> = {
    USER: "user",
    MODEL: "model",
};
