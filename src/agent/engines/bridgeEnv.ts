/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FeatureConfig } from "../../stores/featureStore";
import { bridgeEndpoint, ensureBridge } from "../bridge";
import type { EngineId } from "./types";

type BridgeFeatures = Pick<FeatureConfig, "engineBridgeEnabled" | "engineBridgeModel">;

let featureSource: (() => BridgeFeatures) | undefined;
let modelSource: (() => string | undefined) | undefined;

/** Wire the feature store that decides whether bridged engines are enabled. */
export function setBridgeEnvFeatureSource(source: (() => BridgeFeatures) | undefined): void {
	featureSource = source;
}

/**
 * Wire the model the bridge actually resolves (forced bridge model, else the
 * selected one). The source must return a bare API model id — no provider
 * scope prefix — because the value is passed straight to the external CLI.
 */
export function setBridgeModelSource(source: (() => string | undefined) | undefined): void {
	modelSource = source;
}

/** Bare id of a provider-scoped composite id ("<providerId>::<modelId>"). */
function bareModelId(id: string): string {
	const separator = id.indexOf("::");
	return separator >= 0 ? id.slice(separator + 2) : id;
}

/**
 * Environment that points an external engine at the local protocol bridge.
 * Only pairs verified against official documentation are exposed: Claude Code
 * reads ANTHROPIC_BASE_URL (no trailing /v1 — its SDK appends /v1/messages)
 * plus its model variables, which all point at the same AiWorkHarness model so
 * the CLI's internal tiers (haiku/sonnet/opus) never leave the bridge.
 */
export async function bridgeEnvForEngine(id: EngineId): Promise<Record<string, string> | undefined> {
	const features = featureSource?.();
	if (features?.engineBridgeEnabled !== true) return undefined;
	// TODO: other engines need their own documented base-URL/token variables
	// verified one by one; only Claude Code's Anthropic variables are official.
	if (id !== "claude-code") return undefined;

	let endpoint = bridgeEndpoint();
	if (!endpoint) {
		try {
			endpoint = await ensureBridge();
		} catch {
			return undefined;
		}
	}
	if (!endpoint) return undefined;

	const env: Record<string, string> = {
		ANTHROPIC_BASE_URL: endpoint.url,
		ANTHROPIC_AUTH_TOKEN: endpoint.token,
		// Some Claude Code builds only read the API key variable; both carry the
		// same bridge token on purpose.
		ANTHROPIC_API_KEY: endpoint.token,
		// Telemetry and feature-flag traffic would bypass the bridge and stall on
		// networks where Anthropic is unreachable.
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	};
	const forced = features.engineBridgeModel?.trim();
	const model = forced ? bareModelId(forced) : modelSource?.()?.trim();
	if (model) {
		env.ANTHROPIC_MODEL = model;
		env.ANTHROPIC_SMALL_FAST_MODEL = model;
		env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
		env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
		env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
	}
	return env;
}

/** Everything the Claude Code CLI needs to reach the bridge. */
export type ClaudeBridgeLaunch = {
	/** Still injected into the process environment as a second line of defence. */
	env: Record<string, string>;
	/** Passed via `--settings` so it outranks the user's ~/.claude/settings.json. */
	settings?: { env: Record<string, string> };
	/** Bare model id for `--model`. */
	model?: string;
	/** Path of the settings file once written; empty when writing failed. */
	settingsFile?: string;
};

/**
 * Bridge launch config for Claude Code. The CLI lets a user settings.json
 * `env` block override the process environment (tools like CC Switch write
 * one), so the same values must ride in through `--settings`, which the CLI
 * documents as the highest-priority layer. The user's own settings file is
 * never touched.
 */
export async function claudeBridgeLaunch(): Promise<ClaudeBridgeLaunch | undefined> {
	const env = await bridgeEnvForEngine("claude-code");
	if (!env) return undefined;
	return {
		env,
		settings: { env: { ...env } },
		model: env.ANTHROPIC_MODEL,
	};
}

const CLAUDE_SETTINGS_DIR = path.join(os.tmpdir(), "aiworkharness-bridge");
const CLAUDE_SETTINGS_FILE = path.join(CLAUDE_SETTINGS_DIR, "claude-settings.json");

/** Write the `--settings` payload; returns undefined on any write failure so
 * the caller can fall back to the process environment alone. */
export function writeClaudeSettingsFile(settings: { env: Record<string, string> }): string | undefined {
	try {
		mkdirSync(CLAUDE_SETTINGS_DIR, { recursive: true });
		writeFileSync(CLAUDE_SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
		return CLAUDE_SETTINGS_FILE;
	} catch {
		return undefined;
	}
}

/** Best-effort removal once the CLI has exited; failures are ignored. */
export function removeClaudeSettingsFile(file: string | undefined): void {
	if (!file) return;
	try {
		rmSync(file, { force: true });
	} catch { /* best effort */ }
}
