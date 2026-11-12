/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// Shared translator default values (magic strings used across multiple translators).
// Fallback model id when upstream chunk omits one.
export const MODEL_FALLBACK = "unknown";
// Default image mime when source omits it (base64 blobs without a declared type).
export const DEFAULT_IMAGE_MIME = "image/png";
