/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as assert from "assert";
import * as vscode from "vscode";

suite("Installed extension host integration", () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension("westhack.ai-work-harness");
    assert.ok(extension, "The extension under test must be installed in the development host");
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });

  test("activation registers the real chat/settings/review commands", async () => {
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of ["aiworkharness.addToChat", "aiworkharness.openSettings", "aiworkharness.viewDiff"]) {
      assert.ok(commands.has(command), `Missing registered command: ${command}`);
    }
    // Exercise the actual command handler: untracked paths must be a safe no-op.
    await vscode.commands.executeCommand("aiworkharness.viewDiff", "not-a-pending-file.ts");
  });

  test("activation installs a working original-document provider for review", async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: "aiworkharness-inline-original", path: "/missing.ts" }));
    assert.strictEqual(document.getText(), "");
    assert.strictEqual(document.uri.scheme, "aiworkharness-inline-original");
  });
});
