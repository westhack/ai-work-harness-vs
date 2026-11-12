/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { readShellTranscript } from "./shared";
import { defineTool } from "./types";

export const readContextTool = defineTool("ReadContext", false, async (input, _signal, _callId, ctx) => {
  if (typeof input?.id === "string" && input.id.startsWith("shell_")) {
    return { output: await readShellTranscript(ctx?.shellOwnerKey ?? ctx?.shellSessionKey, input, _signal) };
  }
  if (!ctx?.readContext) return { output: "error: context archive is unavailable" };
  if (typeof input?.id !== "string") return { output: "error: ReadContext requires an archive id" };
  return { output: ctx.readContext(input).replace(/^Error:/, "error:") };
});
