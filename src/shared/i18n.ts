/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/** Value stored in the user's settings. "auto" follows VS Code's display language. */
export type LanguagePreference = "auto" | "en" | "zh-CN";

/** Concrete language actually used to render a webview. */
export type UiLanguage = "en" | "zh-CN";

export const DEFAULT_LANGUAGE: LanguagePreference = "auto";

export const LANGUAGE_OPTIONS: { value: LanguagePreference; label: string }[] = [
	{ value: "auto", label: "Auto (follow VS Code)" },
	{ value: "en", label: "English" },
	{ value: "zh-CN", label: "简体中文" },
];

export function isLanguagePreference(value: unknown): value is LanguagePreference {
	return value === "auto" || value === "en" || value === "zh-CN";
}

export function isUiLanguage(value: unknown): value is UiLanguage {
	return value === "en" || value === "zh-CN";
}

/**
 * Resolve the stored preference to a language the webviews can render.
 * VS Code reports locale ids such as `zh-cn`, `zh-tw`, `en`, `ja`.
 * Every Chinese locale maps to the Simplified Chinese bundle.
 */
export function resolveLanguage(
	preference: LanguagePreference | undefined,
	vscodeLanguage: string | undefined
): UiLanguage {
	if (preference === "en" || preference === "zh-CN") return preference;
	return /^zh(?:-|$)/i.test(vscodeLanguage ?? "") ? "zh-CN" : "en";
}

let runtimeVscodeLanguage = "en";

/**
 * Cache VS Code's display language once at activation. Keeping it here means
 * no other module needs to touch `vscode.env`, which headless hosts, the
 * worker and the unit-test mocks do not always provide.
 */
export function setVscodeLanguage(language: string | undefined): void {
	runtimeVscodeLanguage = language ?? "en";
}

/** Resolve the UI language for a stored preference without importing vscode. */
export function currentLanguage(preference?: LanguagePreference): UiLanguage {
	return resolveLanguage(preference, runtimeVscodeLanguage);
}

/** HTML `lang` value for a webview shell. */
export function htmlLang(language: UiLanguage): string {
	return language === "zh-CN" ? "zh-CN" : "en";
}

/** Strings rendered by the extension host itself (not inside a webview). */
const HOST_ZH: Record<string, string> = {
	"AiWorkHarness Chat": "AiWorkHarness 对话",
	"AiWorkHarness Settings": "AiWorkHarness 设置",
	"AiWorkHarness: Settings saved successfully.": "AiWorkHarness：设置已保存。",
	"Implement with AiWorkHarness": "用 AiWorkHarness 实现",
	"Select a remote job": "选择远程作业",
	"AiWorkHarness: Add Selection to Chat": "AiWorkHarness：将选区添加到对话",
	"AiWorkHarness: New Chat": "AiWorkHarness：新建对话",
	"AiWorkHarness: Review Changes": "AiWorkHarness：审查更改",
	"AiWorkHarness: Remote Jobs": "AiWorkHarness：远程作业",
	"AiWorkHarness: Manage Plugins": "AiWorkHarness：管理插件",
	"Open AiWorkHarness Settings": "打开 AiWorkHarness 设置",
	"Install": "安装",
	"Install {name} globally with npm?": "是否使用 npm 全局安装 {name}？",
	"Install {name} into the extension folder?": "是否将 {name} 安装到扩展目录？",
	"Install failed": "安装失败",
	"Select": "选择",
	"Select the {name} executable": "选择 {name} 可执行文件",
	"Select is not a file": "所选路径不是文件",
	"Could not save the engine path": "无法保存引擎路径",
};

/** Translate a host-side string, leaving English untouched. */
export function hostText(en: string, language: UiLanguage): string {
	return language === "en" ? en : (HOST_ZH[en] ?? en);
}
