/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { findWorkspaceRoot } from "../../context/workspaceUtils";
import { recordCodeGraphEvent } from "../../stores/codeGraphStats";
import { queryCodeGraph } from "../codeGraph";
import { defineTool } from "./types";

const ACTIONS = new Set(["overview", "find", "neighbors"]);

export const codeGraphTool = defineTool("CodeGraph", false, async (input) => {
  const action = String(input?.action ?? "").trim().toLowerCase();
  if (!ACTIONS.has(action)) {
    return { output: "error: action must be one of overview, find, neighbors" };
  }
  const root = findWorkspaceRoot();
  if (!root) return { output: "error: no workspace folder is open" };
  const query = input?.query === undefined ? undefined : String(input.query);
  const limit = typeof input?.limit === "number" && Number.isFinite(input.limit) ? input.limit : 20;
  try {
    const output = await queryCodeGraph(root, action as "overview" | "find" | "neighbors", query, limit);
    recordCodeGraphEvent(root, { type: "toolCall" });
    return { output };
  } catch (error) {
    return { output: `error: ${(error as Error)?.message || error}` };
  }
});
