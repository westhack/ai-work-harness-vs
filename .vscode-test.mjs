/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  version: '1.96.0',
  ...(process.env.AIWORKHARNESS_TEST_EXTENSION_PATH ? { extensionDevelopmentPath: process.env.AIWORKHARNESS_TEST_EXTENSION_PATH } : {}),
  launchArgs: ['--disable-gpu', '--disable-workspace-trust', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
  mocha: { timeout: 20000 },
});
