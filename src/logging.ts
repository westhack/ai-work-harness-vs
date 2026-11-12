/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";

let output: vscode.OutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): vscode.OutputChannel {
  output ??= vscode.window.createOutputChannel("AiWorkHarness");
  context.subscriptions.push(output);
  return output;
}

export function getLog(): vscode.OutputChannel {
  return (output ??= vscode.window.createOutputChannel("AiWorkHarness"));
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  try {
    return typeof error === "string" ? error : JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function logError(scope: string, error: unknown, context?: Record<string, unknown>): void {
  let details = "";
  try {
    if (context) details = ` ${JSON.stringify(context)}`;
  } catch {
    details = " [unserializable context]";
  }
  try {
    getLog().appendLine(`[${new Date().toISOString()}] [error] [${scope}]${details} ${errorText(error)}`);
  } catch {
    console.error(`[AiWorkHarness] [${scope}]`, error);
  }
}
