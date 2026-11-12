/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { Step } from "./types";
export interface Collaborator {
  id: string;
  title: string;
  type?: string;
  model: string;
  readonly: boolean;
  status: "running" | "completed" | "failed" | "interrupted";
  history: Step[];
  mailbox: string[];
  result?: string;
  updatedAt: number;
}
export interface AgentControlRequest { action: "list" | "message" | "followup" | "interrupt" | "wait"; id?: string; message?: string; timeout_ms?: number }
