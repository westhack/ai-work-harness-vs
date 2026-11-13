/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness, AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { stripReasoning } from "./reasoning";

describe("stripReasoning", () => {
  it("drops a complete reasoning block before the answer", () => {
    expect(stripReasoning("<think>The user wants a title.\nPick one.</think>\n\n# Overview")).toBe("# Overview");
  });

  it("is case insensitive and accepts <thinking>", () => {
    expect(stripReasoning("<THINKING>plan</THINKING>Answer")).toBe("Answer");
    expect(stripReasoning("<Think>plan</Think>Answer")).toBe("Answer");
  });

  it("drops a truncated unclosed block", () => {
    expect(stripReasoning("Answer first.\n<think>never finished")).toBe("Answer first.");
    expect(stripReasoning("<think>only reasoning")).toBe("");
  });

  it("drops stray tags", () => {
    expect(stripReasoning("</think>\n# Page")).toBe("# Page");
  });

  it("leaves ordinary text untouched", () => {
    const text = "# Page\n\nUse the `thinking` setting.";
    expect(stripReasoning(text)).toBe(text);
  });
});
