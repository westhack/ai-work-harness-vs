/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ProtocolValue } from "../wireTypes.js";
export function sseChunk(data: ProtocolValue) {
    return `data: ${JSON.stringify(data)}\n\n`;
}
// Build OpenAI chat.completion.chunk SSE frame. Key order: id, object, created, model, choices.
export function chatChunkSse({ id, created, model, delta, finishReason = null }: ProtocolValue) {
    return sseChunk({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
}
