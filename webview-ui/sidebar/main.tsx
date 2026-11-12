/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import "./sidebar.css";
import "../shared/code-highlighting.css";
import { App, ErrorBoundary } from "./App";
import "../shared/motion.css";
import { initializeMotionPreference } from "../shared/motionPreference";
import { applyShellLocale, bindLocaleToRoot } from "../shared/i18n";

initializeMotionPreference();
applyShellLocale(document.getElementById("root"));
const root = createRoot(document.getElementById("root")!);
const render = () => root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
render();
bindLocaleToRoot(render);
