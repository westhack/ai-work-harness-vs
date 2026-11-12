/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// Per-request cancellation; never monkey-patch global fetch.
import { authFetch } from '../../auth/network.js';
export function proxyAwareFetch(
    url: string | URL | Request,
    init: RequestInit = {},
    _proxyOptions?: unknown,
    directFetch?: (url: string, init: RequestInit) => Promise<Response>,
): ReturnType<typeof authFetch> {
    if (directFetch && typeof url === "string") return directFetch(url, init) as ReturnType<typeof authFetch>;
    return authFetch(url, init);
}
