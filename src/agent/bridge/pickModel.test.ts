/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { pickBridgeModel } from "./pickModel";

describe("pickBridgeModel", () => {
	it("prefers the configured bridge model over everything else", () => {
		expect(pickBridgeModel({ forced: "gpt-5", requested: "claude-test", known: ["claude-test"], fallback: "api::model" })).toBe("gpt-5");
	});

	it("keeps a requested id this installation knows", () => {
		expect(pickBridgeModel({ requested: "claude-test", known: ["claude-test", "gpt-5"], fallback: "gpt-5" })).toBe("claude-test");
	});

	it("matches a requested id against a provider-scoped known id", () => {
		expect(pickBridgeModel({ requested: "claude-test", known: ["popular:anthropic::claude-test"], fallback: "gpt-5" })).toBe("claude-test");
	});

	it("falls back to the selected model for an unknown requested id", () => {
		expect(pickBridgeModel({ requested: "claude-sonnet-4-5-20250929", known: ["gpt-5"], fallback: "api::gpt-5" })).toBe("api::gpt-5");
	});

	it("returns undefined when no forced, known or fallback model exists", () => {
		expect(pickBridgeModel({ requested: "unknown", known: [], fallback: "" })).toBeUndefined();
	});
});
