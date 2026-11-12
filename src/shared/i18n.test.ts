/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import { currentLanguage, hostText, htmlLang, resolveLanguage, setVscodeLanguage } from "./i18n";

describe("language resolution", () => {
	it("follows VS Code's display language in auto mode", () => {
		expect(resolveLanguage("auto", "zh-cn")).toBe("zh-CN");
		expect(resolveLanguage("auto", "zh-tw")).toBe("zh-CN");
		expect(resolveLanguage(undefined, "ja")).toBe("en");
		expect(resolveLanguage("auto", "en")).toBe("en");
	});

	it("lets an explicit preference override the editor language", () => {
		expect(resolveLanguage("zh-CN", "en")).toBe("zh-CN");
		expect(resolveLanguage("en", "zh-cn")).toBe("en");
	});

	it("caches the display language for callers without a vscode import", () => {
		setVscodeLanguage("zh-cn");
		expect(currentLanguage("auto")).toBe("zh-CN");
		expect(currentLanguage("en")).toBe("en");
		expect(hostText("AiWorkHarness Settings", currentLanguage("auto"))).toBe("AiWorkHarness 设置");
		setVscodeLanguage("en");
		expect(currentLanguage("auto")).toBe("en");
		expect(hostText("AiWorkHarness Settings", "en")).toBe("AiWorkHarness Settings");
	});

	it("provides the html lang attribute", () => {
		expect(htmlLang("zh-CN")).toBe("zh-CN");
		expect(htmlLang("en")).toBe("en");
	});
});
