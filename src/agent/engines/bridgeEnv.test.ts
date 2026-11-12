/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const bridgeMock = vi.hoisted(() => ({
	bridgeEndpoint: vi.fn(() => ({ url: "http://127.0.0.1:4321", token: "test-token" })),
	ensureBridge: vi.fn(async () => ({ url: "http://127.0.0.1:4321", token: "test-token" })),
}));

vi.mock("../bridge", () => bridgeMock);

import { bridgeEnvForEngine, claudeBridgeLaunch, setBridgeEnvFeatureSource, setBridgeModelSource } from "./bridgeEnv";

const config = (patch: { enabled?: boolean; model?: string }) => ({
	engineBridgeEnabled: patch.enabled,
	engineBridgeModel: patch.model,
});

const MODEL_KEYS = [
	"ANTHROPIC_MODEL",
	"ANTHROPIC_SMALL_FAST_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
];

afterEach(() => {
	setBridgeModelSource(undefined);
	setBridgeEnvFeatureSource(undefined);
	vi.clearAllMocks();
});

describe("bridgeEnvForEngine", () => {
	it("returns undefined while the bridge switch is off", async () => {
		setBridgeEnvFeatureSource(() => config({ enabled: false }));
		setBridgeModelSource(() => "gpt-4o");
		expect(await bridgeEnvForEngine("claude-code")).toBeUndefined();
	});

	it("points Claude Code at the local Anthropic endpoint without a /v1 suffix", async () => {
		setBridgeEnvFeatureSource(() => config({ enabled: true }));
		expect(await bridgeEnvForEngine("claude-code")).toEqual({
			ANTHROPIC_BASE_URL: "http://127.0.0.1:4321",
			ANTHROPIC_AUTH_TOKEN: "test-token",
			ANTHROPIC_API_KEY: "test-token",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		});
	});

	it("uses the bridge model for every model tier", async () => {
		setBridgeEnvFeatureSource(() => config({ enabled: true }));
		setBridgeModelSource(() => "gpt-4o");
		const env = (await bridgeEnvForEngine("claude-code"))!;
		expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4321");
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-token");
		expect(env.ANTHROPIC_API_KEY).toBe("test-token");
		expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
		for (const key of MODEL_KEYS) expect(env[key]).toBe("gpt-4o");
		expect(Object.keys(env).filter((key) => key.startsWith("ANTHROPIC_"))).toHaveLength(8);
	});

	it("prefers the forced bridge model and strips its provider scope", async () => {
		setBridgeEnvFeatureSource(() => config({ enabled: true, model: "anthropic::claude-sonnet-4-5" }));
		setBridgeModelSource(() => "gpt-4o");
		const env = (await bridgeEnvForEngine("claude-code"))!;
		for (const key of MODEL_KEYS) expect(env[key]).toBe("claude-sonnet-4-5");
	});

	it("omits model variables when neither a forced model nor a source exists", async () => {
		setBridgeEnvFeatureSource(() => config({ enabled: true }));
		const env = (await bridgeEnvForEngine("claude-code"))!;
		expect(Object.keys(env).filter((key) => key.endsWith("MODEL"))).toEqual([]);
		expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4321");
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-token");
	});

	it("leaves engines without verified variables untouched", async () => {
		setBridgeEnvFeatureSource(() => config({ enabled: true }));
		setBridgeModelSource(() => "gpt-4o");
		expect(await bridgeEnvForEngine("codex")).toBeUndefined();
	});
});

describe("claudeBridgeLaunch", () => {
	it("returns undefined while the bridge switch is off", async () => {
		setBridgeEnvFeatureSource(() => config({ enabled: false }));
		setBridgeModelSource(() => "gpt-4o");
		expect(await claudeBridgeLaunch()).toBeUndefined();
	});

	it("mirrors the process env into the highest-priority settings payload", async () => {
		setBridgeEnvFeatureSource(() => config({ enabled: true, model: "anthropic::claude-sonnet-4-5" }));
		setBridgeModelSource(() => "gpt-4o");
		const launch = (await claudeBridgeLaunch())!;
		expect(launch.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4321");
		expect(launch.settings?.env).toEqual(launch.env);
		expect(launch.model).toBe("claude-sonnet-4-5");
	});
});
