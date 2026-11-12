// @vitest-environment jsdom
/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { afterEach, describe, expect, it } from "vitest";
import { getLocale, onLocaleChange, setLocale, t } from "./i18n";

afterEach(() => setLocale("en"));

describe("webview translations", () => {
  it("renders English source text by default and Chinese when selected", () => {
    expect(t("Send")).toBe("Send");
    setLocale("zh-CN");
    expect(t("Send")).toBe("发送");
    expect(t("General")).toBe("常规");
    expect(document.documentElement.lang).toBe("zh-CN");
    setLocale("en");
    expect(t("Send")).toBe("Send");
    expect(document.documentElement.lang).toBe("en");
  });

  it("falls back to English for strings absent from the dictionary", () => {
    setLocale("zh-CN");
    expect(t("A brand new string")).toBe("A brand new string");
  });

  it("interpolates placeholders", () => {
    setLocale("zh-CN");
    expect(t("{count} teams", { count: 3 })).toBe("3 个团队");
  });

  it("notifies subscribers only when the language actually changes", () => {
    let calls = 0;
    const unsubscribe = onLocaleChange(() => { calls++; });
    setLocale("zh-CN");
    setLocale("zh-CN");
    expect(calls).toBe(1);
    setLocale("fr");
    expect(getLocale()).toBe("zh-CN");
    unsubscribe();
    setLocale("en");
    expect(calls).toBe(1);
  });
});
