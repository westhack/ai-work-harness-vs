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
import "./style.css";
import { App } from "./App";
import { applyShellLocale, bindLocaleToRoot } from "../shared/i18n";

applyShellLocale(document.getElementById("root"));
const root = createRoot(document.getElementById("root")!);
const render = () => root.render(<App />);
render();
bindLocaleToRoot(render);
