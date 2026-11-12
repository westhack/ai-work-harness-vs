/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

export interface PickBridgeModelOptions {
	/** Explicit engine bridge model configured in AiWorkHarness settings. */
	forced?: string;
	/** Model id the external engine sent with its request. */
	requested?: string;
	/** Model ids this installation knows about (catalog, custom, local). */
	known: readonly string[];
	/** Currently selected AiWorkHarness model. */
	fallback?: string;
}

/** Bare id of a provider-scoped composite id ("<providerId>::<modelId>"). */
function bareModelId(id: string): string {
	const separator = id.indexOf("::");
	return separator >= 0 ? id.slice(separator + 2) : id;
}

/**
 * Choose the model a bridged external engine should run on. An engine's own
 * model id is only honored when this installation actually serves it; anything
 * else falls back to the user's selected model so an unknown id never fails a
 * request. Returns undefined when no usable id exists.
 */
export function pickBridgeModel(opts: PickBridgeModelOptions): string | undefined {
	const forced = opts.forced?.trim();
	if (forced) return forced;

	const requested = opts.requested?.trim();
	if (requested) {
		if (opts.known.some((id) => id === requested)) return requested;
		const bare = bareModelId(requested);
		if (opts.known.some((id) => bareModelId(id) === bare)) return requested;
	}

	return opts.fallback?.trim() || undefined;
}
