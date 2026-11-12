/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { ModelBridge, type ModelBridgeDeps } from "./server";

let deps: ModelBridgeDeps | undefined;
let bridge: ModelBridge | undefined;
let starting: Promise<{ url: string; token: string } | undefined> | undefined;

/** Register the host services the bridge translates onto. */
export function setBridgeDeps(next: ModelBridgeDeps): void {
	deps = next;
}

export function isBridgeRunning(): boolean {
	return !!bridge?.endpoint;
}

/** Start the local bridge once; concurrent callers share the same promise. */
export async function ensureBridge(): Promise<{ url: string; token: string } | undefined> {
	if (!deps) return undefined;
	if (bridge?.endpoint) return bridge.endpoint;
	if (!starting) {
		const instance = new ModelBridge(deps);
		bridge = instance;
		starting = instance.start()
			.catch((error) => {
				bridge = undefined;
				throw error;
			})
			.finally(() => { starting = undefined; });
	}
	return starting;
}

export async function stopBridge(): Promise<void> {
	const pending = starting;
	if (pending) await pending.catch(() => undefined);
	const instance = bridge;
	bridge = undefined;
	starting = undefined;
	await instance?.stop();
}

export function bridgeEndpoint(): { url: string; token: string } | undefined {
	return bridge?.endpoint;
}
