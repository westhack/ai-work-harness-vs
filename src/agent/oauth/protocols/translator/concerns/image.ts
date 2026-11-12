/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ProtocolValue } from "../../wireTypes.js";
export const encodeDataUri = (mimeType: ProtocolValue, base64: ProtocolValue) => 'data:' + mimeType + ';base64,' + base64;
export function parseDataUri(url: ProtocolValue) { const m = typeof url === 'string' && /^data:([^;]+);base64,([\s\S]+)$/.exec(url); return m ? { mimeType: m[1], base64: m[2] } : null; }
export async function fetchImageAsBase64() { throw Object.assign(new Error('Attach image data before using this provider; remote image retrieval is not supported.'), { status: 400 }); }
