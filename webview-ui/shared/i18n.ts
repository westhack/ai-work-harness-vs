/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { UiLanguage } from "../../src/shared/i18n";
import { zhCN } from "./locales/zh-CN";

const DICTIONARIES: Record<UiLanguage, Record<string, string>> = {
  en: {},
  "zh-CN": zhCN,
};

let current: UiLanguage = "en";
const listeners = new Set<() => void>();

export function getLocale(): UiLanguage {
  return current;
}

/** Subscribe to language changes. Returns an unsubscribe function. */
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Switch the webview language. The host also writes the resolved language into
 * the HTML shell, so the first paint is already correct; this handles live
 * switches without reloading the webview.
 */
export function setLocale(next: unknown): void {
  if (next !== "en" && next !== "zh-CN") return;
  document.documentElement.lang = next;
  if (current === next) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match);
}

/**
 * Translate a UI string. The English source text is the key, so English needs
 * no translations and any string missing from a dictionary stays readable.
 * Interpolate dynamic parts with `{name}` placeholders.
 */
export function t(en: string, vars?: Record<string, string | number>): string {
  const text = current === "en" ? en : (DICTIONARIES[current][en] ?? en);
  return interpolate(text, vars);
}

/**
 * Render callback for a webview root. Re-rendering the existing tree keeps all
 * component state (drafts, open sections, scroll) while picking up new strings.
 */
export function bindLocaleToRoot(render: () => void): void {
  onLocaleChange(render);
}

/** Read the language the host embedded in the HTML shell (before first paint). */
export function applyShellLocale(root: HTMLElement | null): void {
  setLocale(root?.dataset.lang);
}
