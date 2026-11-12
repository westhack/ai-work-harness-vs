/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ProtocolValue } from "../wireTypes.js";
// Never fabricate model reasoning to bypass validation.
export const injectReasoningContent = ({ body }: ProtocolValue) => body;
