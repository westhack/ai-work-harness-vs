/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
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
	"Ai Work Harness Chat": "Ai Work Harness 对话",
	"Ai Work Harness Settings": "Ai Work Harness 设置",
	"Ai Work Harness: Settings saved successfully.": "Ai Work Harness：设置已保存。",
	"Implement with Ai Work Harness": "用 Ai Work Harness 实现",
	"Select a remote job": "选择远程作业",
	"Ai Work Harness: Add Selection to Chat": "Ai Work Harness：将选区添加到对话",
	"Ai Work Harness: New Chat": "Ai Work Harness：新建对话",
	"Project Docs": "项目文档",
	"Code Graph": "代码图谱",
	"On": "开",
	"Off": "关",
	"Include the cached graphify code graph in agent context. Click to toggle.": "将缓存的 graphify 代码图谱注入智能体上下文，点击切换。",
	"The code graph is included in agent context.": "代码图谱已加入智能体上下文。",
	"The code graph is no longer included in agent context.": "代码图谱已从智能体上下文中移除。",
	"No graph built yet.": "尚未构建图谱。",
	"stale: HEAD has moved": "已过期：HEAD 已变化",
	"This page has not been generated yet.": "该页面尚未生成。",
	"This page has not been translated yet.": "该页面尚未翻译。",
	"Could not read the graph data from graph.html.": "无法从 graph.html 读取图谱数据。",
	"Open a folder to generate documentation.": "请先打开一个文件夹再生成文档。",
	"Open a folder to generate a knowledge graph.": "请先打开一个文件夹再生成知识图谱。",
	"Ai Work Harness: Review Changes": "Ai Work Harness：审查更改",
	"Ai Work Harness: Remote Jobs": "Ai Work Harness：远程作业",
	"Ai Work Harness: Manage Plugins": "Ai Work Harness：管理插件",
	"Open Ai Work Harness Settings": "打开 Ai Work Harness 设置",
	"Ai Work Harness: open a file and select the code you want to work with.": "Ai Work Harness：请先打开文件，并选中要处理的代码。",
	"Ai Work Harness: select the code, or put the cursor on the comment describing what to generate.": "Ai Work Harness：请选中代码，或把光标放在描述要生成内容的注释上。",
	"Install": "安装",
	"Install {name} globally with npm?": "是否使用 npm 全局安装 {name}？",
	"Install {name} into the extension folder?": "是否将 {name} 安装到扩展目录？",
	"Install failed": "安装失败",
	"Select": "选择",
	"Select the {name} executable": "选择 {name} 可执行文件",
	"Select is not a file": "所选路径不是文件",
	"Could not save the engine path": "无法保存引擎路径",
	"Edit catalog prompt": "编辑目录提示词",
	"Edit page prompt": "编辑页面提示词",
	"Edit mind map prompt": "编辑思维导图提示词",
	"Edit translation prompt": "编辑翻译提示词",
	"Open a folder to generate a mind map.": "请先打开一个文件夹再生成思维导图。",
	"This mind map has not been generated yet.": "该思维导图尚未生成。",
	"Restore default prompts": "恢复默认提示词",
	"Documentation prompts": "文档提示词",
	"Overwrite all prompt skills with the defaults?": "用默认内容覆盖全部提示词技能？",
	"Restore defaults": "恢复默认",
	"Default prompts restored.": "已恢复默认提示词。",
};

/** Translate a host-side string, leaving English untouched. */
export function hostText(en: string, language: UiLanguage): string {
	return language === "en" ? en : (HOST_ZH[en] ?? en);
}
