/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { QODER_CN_CONFIG } from "../constants/oauth.js";
import { createQoderProvider } from "./qoder.js";

// Qoder CN (qoder.com.cn) — same device flow as intl Qoder, CN endpoints.
export default createQoderProvider(QODER_CN_CONFIG);
