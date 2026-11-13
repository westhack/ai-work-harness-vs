/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SettingsManager } from "../stores/settingsManager";
import type { FeatureStore } from "../stores/featureStore";
import { currentLanguage, hostText, isUiLanguage } from "../shared/i18n";
import { findWorkspaceRoot } from "../context/workspaceUtils";
import { renderWebviewHtml, webviewResourceRoots } from "./webviewHtml";
import {
	cancelProjectDocs,
	exportProjectDocs,
	generateMindMap,
	generateProjectDocs,
	getProjectDocsStatus,
	onProjectDocsStatus,
	translateProjectDocs,
} from "../agent/projectDocs/generate";
import {
	cancelKnowledgeGraph,
	findGraphify,
	generateKnowledgeGraph,
	getGraphifyStatus,
	isGraphifyRunning,
	knowledgeGraphArtifacts,
	onGraphifyStatus,
	readGraphView,
} from "../agent/knowledgeGraph";
import { resolveRoute } from "../agent/docsPlanner";
import { mindmapPath, projectDocsRoot, readManifest, readMindMap, readPage, translationDir } from "../agent/projectDocs/store";
import { docSkillPath, ensureDocSkills, resetDocSkills } from "../agent/projectDocs/skillPrompts";

/** Only ordinary web pages may be opened from the panel. */
function isWebUrl(value: unknown): boolean {
	if (typeof value !== "string") return false;
	try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; }
}

/** Resolve a workspace-relative path without allowing it to escape the repo. */
function insideWorkspace(workspace: string, candidate: unknown): string | undefined {
	if (typeof candidate !== "string" || !candidate.trim()) return undefined;
	const file = resolve(workspace, candidate);
	const base = resolve(workspace);
	return file === base || file.startsWith(base + (process.platform === "win32" ? "\\" : "/")) ? file : undefined;
}

export class ProjectDocsPanel {
	public static currentPanel: ProjectDocsPanel | undefined;
	public static readonly viewType = "aiworkharness.projectDocs";
	private readonly _panel: vscode.WebviewPanel;
	private _disposables: vscode.Disposable[] = [];
	private _statusTimer: NodeJS.Timeout | undefined;
	private readonly _pushDocs: () => void;
	private readonly _pushGraph: () => void;
	/** Language currently shown in the webview; undefined means the source wiki. */
	private _viewLanguage: string | undefined;

	public static createOrShow(context: vscode.ExtensionContext, settingsManager: SettingsManager, featureStore: FeatureStore): void {
		const language = currentLanguage(featureStore.get().language);
		if (ProjectDocsPanel.currentPanel) {
			ProjectDocsPanel.currentPanel._panel.reveal(undefined, false);
			void ProjectDocsPanel.currentPanel._sendState();
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			ProjectDocsPanel.viewType,
			hostText("Project Docs", language),
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					...webviewResourceRoots(context.extensionUri),
					vscode.Uri.joinPath(context.globalStorageUri, "project-docs"),
				],
			},
		);
		panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
		ProjectDocsPanel.currentPanel = new ProjectDocsPanel(panel, context, settingsManager, featureStore);
	}

	private constructor(
		panel: vscode.WebviewPanel,
		private readonly context: vscode.ExtensionContext,
		private readonly settingsManager: SettingsManager,
		private readonly featureStore: FeatureStore,
	) {
		this._panel = panel;
		this._panel.webview.html = renderWebviewHtml(
			this._panel.webview,
			context.extensionUri,
			"projectDocs",
			hostText("Project Docs", currentLanguage(featureStore.get().language)),
			currentLanguage(featureStore.get().language),
		);
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Generation reports per page; coalesce bursts so the webview is not
		// re-rendered for every log line.
		this._pushDocs = () => this._throttle(() => this._panel.webview.postMessage({ type: "docsStatus", status: getProjectDocsStatus() }));
		this._pushGraph = () => this._throttle(() => this._panel.webview.postMessage({ type: "graphifyStatus", status: getGraphifyStatus() }));
		this._disposables.push({ dispose: onProjectDocsStatus(() => this._pushDocs()) });
		this._disposables.push({ dispose: onGraphifyStatus(() => this._pushGraph()) });

		this._panel.webview.onDidReceiveMessage(async (message) => {
			switch (message.type) {
				case "ready":
					await this._sendState();
					break;
				case "generate":
					await this._generate(message.mode === "incremental" ? "incremental" : "full");
					break;
				case "regeneratePage":
					await this._generate("full", [message.slug]);
					break;
				case "cancel":
					cancelProjectDocs();
					break;
				case "generateMindmap":
					await this._generateMindmap();
					break;
				case "readMindmap": {
					const workspace = findWorkspaceRoot();
					const root = workspace ? projectDocsRoot(workspace) : undefined;
					const markdown = root ? await readMindMap(root) : undefined;
					this._panel.webview.postMessage(markdown === undefined
						? { type: "mindmapError", error: hostText("This mind map has not been generated yet.", this._language()) }
						: { type: "mindmapContent", markdown });
					break;
				}
				case "translate":
					if (isUiLanguage(message.language)) await this._translate(message.language);
					break;
				case "setLanguage":
					if (typeof message.language === "string") {
						this._viewLanguage = message.language;
						await this._sendState();
					}
					break;
				case "readGraph": {
					const workspace = findWorkspaceRoot();
					const view = workspace ? await readGraphView(workspace) : undefined;
					this._panel.webview.postMessage(view
						? { type: "graphData", nodes: view.nodes, edges: view.edges }
						: { type: "graphData", error: hostText("Could not read the graph data from graph.html.", this._language()) });
					break;
				}
				case "openGraphHtml": {
					const workspace = findWorkspaceRoot();
					const artifacts = workspace ? knowledgeGraphArtifacts(workspace) : undefined;
					if (artifacts && existsSync(artifacts.html)) await vscode.env.openExternal(vscode.Uri.file(artifacts.html));
					break;
				}
				case "export":
					await this._export();
					break;
				case "readPage": {
					const workspace = findWorkspaceRoot();
					const root = workspace ? projectDocsRoot(workspace) : undefined;
					const sourceLanguage = await this._sourceLanguage(root);
					const language = typeof message.language === "string" && message.language
						? message.language
						: sourceLanguage;
					const dir = !root
						? undefined
						: language === sourceLanguage ? root : translationDir(root, language);
					const markdown = dir ? await readPage(dir, String(message.slug ?? "")) : undefined;
					const missing = language === sourceLanguage
						? "This page has not been generated yet."
						: "This page has not been translated yet.";
					this._panel.webview.postMessage(markdown === undefined
						? { type: "pageError", slug: message.slug, language, error: hostText(missing, this._language()) }
						: { type: "pageContent", slug: message.slug, language, markdown });
					break;
				}
				case "generateGraph":
					await this._generateGraph();
					break;
				case "cancelGraph":
					cancelKnowledgeGraph();
					break;
				case "openSource": {
					const workspace = findWorkspaceRoot();
					const file = workspace ? insideWorkspace(workspace, message.path) : undefined;
					if (file && existsSync(file)) await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
					break;
				}
				case "openExternal":
					if (isWebUrl(message.url)) await vscode.env.openExternal(vscode.Uri.parse(message.url));
					break;
				case "openGraphifySetting":
					await vscode.commands.executeCommand("workbench.action.openSettings", "aiworkharness.graphifyPath");
					break;
				case "docPrompts":
					await this._promptMenu();
					break;
			}
		});
	}

	/** Edit or restore the documentation skills that drive catalog and page generation. */
	private async _promptMenu(): Promise<void> {
		const language = this._language();
		await ensureDocSkills();
		const pick = await vscode.window.showQuickPick(
			[
				{ label: hostText("Edit catalog prompt", language), action: "catalog" },
				{ label: hostText("Edit page prompt", language), action: "page" },
				{ label: hostText("Edit mind map prompt", language), action: "mindmap" },
				{ label: hostText("Edit translation prompt", language), action: "translation" },
				{ label: hostText("Restore default prompts", language), action: "reset" },
			],
			{ placeHolder: hostText("Documentation prompts", language) },
		);
		if (!pick) return;
		if (pick.action === "reset") {
			const confirm = await vscode.window.showWarningMessage(
				hostText("Overwrite all prompt skills with the defaults?", language),
				{ modal: true },
				hostText("Restore defaults", language),
			);
			if (confirm !== hostText("Restore defaults", language)) return;
			await resetDocSkills();
			void vscode.window.showInformationMessage(hostText("Default prompts restored.", language));
			return;
		}
		const id = pick.action === "catalog"
			? "deepwiki-catalog"
			: pick.action === "page" ? "deepwiki-page"
				: pick.action === "mindmap" ? "deepwiki-mindmap" : "deepwiki-translation";
		const file = docSkillPath(id);
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
		await vscode.window.showTextDocument(document, { preview: false });
	}

	private _language() {
		return currentLanguage(this.featureStore.get().language);
	}

	private _throttle(send: () => void): void {
		if (this._statusTimer) return;
		this._statusTimer = setTimeout(() => {
			this._statusTimer = undefined;
			send();
		}, 150);
	}

	private async _generate(mode: "full" | "incremental", only?: string[]): Promise<void> {
		const workspace = findWorkspaceRoot();
		if (!workspace) {
			this._panel.webview.postMessage({ type: "actionError", error: hostText("Open a folder to generate documentation.", this._language()) });
			return;
		}
		if (only?.length) mode = "full";
		const result = await generateProjectDocs({
			workspaceRoot: workspace,
			settingsManager: this.settingsManager,
			featureStore: this.featureStore,
			language: this._language(),
			mode,
			only,
		});
		if (!result.ok && !result.cancelled) {
			this._panel.webview.postMessage({ type: "actionError", error: result.error ?? "" });
		}
		// A new source snapshot invalidates every translation; return to the source view.
		this._viewLanguage = undefined;
		await this._sendState();
	}

	private async _generateMindmap(): Promise<void> {
		const workspace = findWorkspaceRoot();
		if (!workspace) {
			this._panel.webview.postMessage({ type: "actionError", error: hostText("Open a folder to generate a mind map.", this._language()) });
			return;
		}
		const result = await generateMindMap({
			workspaceRoot: workspace,
			settingsManager: this.settingsManager,
			featureStore: this.featureStore,
			language: this._language(),
		});
		if (!result.ok && !result.cancelled) {
			this._panel.webview.postMessage({ type: "actionError", error: result.error ?? "" });
		}
		await this._sendState();
	}

	private async _translate(targetLanguage: string): Promise<void> {
		const workspace = findWorkspaceRoot();
		if (!workspace) {
			this._panel.webview.postMessage({ type: "actionError", error: hostText("Open a folder to generate documentation.", this._language()) });
			return;
		}
		const root = projectDocsRoot(workspace);
		const sourceLanguage = await this._sourceLanguage(root);
		const result = await translateProjectDocs({
			workspaceRoot: workspace,
			settingsManager: this.settingsManager,
			featureStore: this.featureStore,
			sourceLanguage,
			targetLanguage: targetLanguage === "zh-CN" ? "zh-CN" : "en",
		});
		if (!result.ok && !result.cancelled) {
			this._panel.webview.postMessage({ type: "actionError", error: result.error ?? "" });
		}
		if (result.ok || result.cancelled) this._viewLanguage = targetLanguage;
		await this._sendState();
	}

	/** Language the wiki was written in; older manifests fall back to the UI language. */
	private async _sourceLanguage(root: string | undefined): Promise<string> {
		const manifest = root ? await readManifest(root) : undefined;
		return isUiLanguage(manifest?.language) ? manifest.language : this._language();
	}

	/** Translation manifests beside the source wiki, newest first. */
	private async _translations(root: string, sourceGeneratedAt?: number): Promise<{ language: string; generatedAt: number; stale: boolean }[]> {
		const base = join(root, "i18n");
		const entries = await readdir(base, { withFileTypes: true }).catch(() => undefined);
		if (!entries) return [];
		const out: { language: string; generatedAt: number; stale: boolean }[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const manifest = await readManifest(join(base, entry.name));
			if (!manifest) continue;
			out.push({
				language: entry.name,
				generatedAt: manifest.generatedAt,
				stale: manifest.sourceGeneratedAt !== sourceGeneratedAt,
			});
		}
		return out.sort((a, b) => b.generatedAt - a.generatedAt);
	}

	private async _export(): Promise<void> {
		const workspace = findWorkspaceRoot();
		if (!workspace) return;
		const result = await exportProjectDocs(workspace);
		this._panel.webview.postMessage({ type: "exportDone", ...result });
	}

	private async _generateGraph(): Promise<void> {
		const workspace = findWorkspaceRoot();
		if (!workspace) {
			this._panel.webview.postMessage({ type: "actionError", error: hostText("Open a folder to generate a knowledge graph.", this._language()) });
			return;
		}
		const binary = vscode.workspace.getConfiguration("aiworkharness").get<string>("graphifyPath", "").trim() || undefined;
		const result = await generateKnowledgeGraph({
			workspaceRoot: workspace,
			binary,
			resolveModel: async (signal) => {
				const bound = this.featureStore.get().docsGraphifyModel?.trim();
				const route = await resolveRoute(this.settingsManager, this.featureStore, signal, bound || undefined);
				return {
					kind: route.kind,
					model: route.model,
					apiBaseUrl: route.apiBaseUrl,
					apiKey: route.apiKey,
					oauthKind: route.oauthKind,
					apiKeyPool: route.apiKeyPool,
				};
			},
		});
		if (!result.ok && !result.cancelled) {
			this._panel.webview.postMessage({ type: "actionError", error: result.error ?? "" });
		}
		await this._sendState();
	}

	private async _sendState(): Promise<void> {
		const workspace = findWorkspaceRoot();
		const language = this._language();
		const root = workspace ? projectDocsRoot(workspace) : undefined;
		const sourceManifest = root ? await readManifest(root) : undefined;
		const sourceLanguage = isUiLanguage(sourceManifest?.language) ? sourceManifest.language : language;
		const translations = root ? await this._translations(root, sourceManifest?.generatedAt) : [];
		let viewLanguage = this._viewLanguage ?? sourceLanguage;
		// A translation that no longer exists falls back to the source wiki.
		if (viewLanguage !== sourceLanguage && !translations.some((item) => item.language === viewLanguage)) {
			viewLanguage = sourceLanguage;
			this._viewLanguage = viewLanguage;
		}
		const viewRoot = !root ? undefined : viewLanguage === sourceLanguage ? root : translationDir(root, viewLanguage);
		const manifest = viewRoot ? await readManifest(viewRoot) : undefined;
		const pages = (manifest?.pages ?? []).map((page) => ({
			group: page.group,
			title: page.title,
			slug: page.slug,
			description: page.description,
			exists: !!viewRoot && !!page.slug && existsSync(join(viewRoot, "pages", `${page.slug}.md`)),
		}));
		const artifacts = workspace ? knowledgeGraphArtifacts(workspace) : undefined;
		const binary = await findGraphify();
		const mindmapFile = root ? mindmapPath(root) : undefined;
		const mindmapStat = mindmapFile && existsSync(mindmapFile) ? await stat(mindmapFile).catch(() => undefined) : undefined;
		this._panel.webview.postMessage({
			type: "state",
			workspace: workspace ?? "",
			language,
			sourceLanguage,
			viewLanguage,
			translations,
			manifest: manifest ? { commit: manifest.commit, model: manifest.model, generatedAt: manifest.generatedAt, catalog: manifest.catalog } : undefined,
			pages,
			status: getProjectDocsStatus(),
			mindmap: { exists: !!mindmapStat, generatedAt: mindmapStat?.mtimeMs },
			graph: {
				running: isGraphifyRunning(),
				status: getGraphifyStatus(),
				available: !!binary,
				hasArtifacts: !!artifacts && existsSync(artifacts.html),
			},
		});
	}

	public dispose(): void {
		ProjectDocsPanel.currentPanel = undefined;
		if (this._statusTimer) clearTimeout(this._statusTimer);
		this._panel.dispose();
		for (const disposable of this._disposables) disposable.dispose();
		this._disposables = [];
	}
}
