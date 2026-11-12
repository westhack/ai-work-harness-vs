/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ProtocolValue } from "../wireTypes.js";
import { PROVIDER_MODELS } from '../providers/index.js';
export { PROVIDER_MODELS };
export const getProviderModels = (kind: ProtocolValue) => PROVIDER_MODELS[kind] || [];
export function getModelUpstreamId(kind: ProtocolValue, model: string) { return getProviderModels(kind).find((entry: ProtocolValue) => entry.id === model)?.upstreamModelId || model; }
