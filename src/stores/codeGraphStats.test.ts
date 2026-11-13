/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("vscode", () => ({}));
import { getCodeGraphStats, initCodeGraphStats, recordCodeGraphEvent } from "./codeGraphStats";

beforeEach(() => {
	const state = new Map<string, unknown>();
	initCodeGraphStats({
		globalState: {
			get: (key: string) => state.get(key),
			update: async (key: string, value: unknown) => { state.set(key, value); },
		},
	} as any);
});

describe("codeGraphStats", () => {
	it("counts builds, injections and tool calls per workspace", async () => {
		await recordCodeGraphEvent("H:\\repo\\a", { type: "build", ok: true });
		await recordCodeGraphEvent("H:\\repo\\a", { type: "build", ok: false });
		await recordCodeGraphEvent("H:\\repo\\a", { type: "inject", chars: 4200 });
		await recordCodeGraphEvent("H:\\repo\\a", { type: "inject", chars: 800 });
		await recordCodeGraphEvent("H:\\repo\\a", { type: "toolCall" });
		const stats = getCodeGraphStats("H:\\repo\\a");
		expect(stats).toMatchObject({ builds: 1, buildFailures: 1, injections: 2, injectedChars: 5000, toolCalls: 1 });
		expect(stats.lastBuildAt).toBeGreaterThan(0);
	});

	it("keeps workspaces isolated", async () => {
		await recordCodeGraphEvent("H:\\repo\\a", { type: "toolCall" });
		expect(getCodeGraphStats("H:\\repo\\b")).toEqual({ builds: 0, buildFailures: 0, injections: 0, injectedChars: 0, toolCalls: 0 });
	});

	it("ignores empty roots", async () => {
		await recordCodeGraphEvent("", { type: "toolCall" });
		expect(getCodeGraphStats("H:\\repo\\a").toolCalls).toBe(0);
	});
});
