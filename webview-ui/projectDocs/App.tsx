/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { DataSet, Network } from "vis-network/standalone";
import type { Edge, Node } from "vis-network/standalone";
import "vis-network/styles/vis-network.css";
import { Icon } from "../shared/icons";
import { MermaidMarkdown } from "./MermaidMarkdown";
import { t } from "../shared/i18n";
import { vscode } from "../shared/vscode";

interface DocsPage {
  group: string;
  title: string;
  slug: string;
  description: string;
  exists: boolean;
}

interface CatalogNode {
  title: string;
  path: string;
  order: number;
  children: CatalogNode[];
  description?: string;
  sources?: string[];
}

interface DocsStatus {
  phase: "idle" | "scanning" | "catalog" | "pages" | "finalizing" | "translating" | "mindmap" | "done" | "error" | "cancelled";
  message: string;
  done: number;
  total: number;
  page?: string;
  error?: string;
  logs: string[];
}

interface GraphStatus {
  phase: "idle" | "detecting" | "extracting" | "clustering" | "verifying" | "done" | "error" | "cancelled";
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  logs: string[];
}

interface GraphInfo {
  running: boolean;
  status: GraphStatus;
  available: boolean;
  hasArtifacts: boolean;
}

interface TranslationInfo {
  language: string;
  generatedAt: number;
  stale: boolean;
}

interface StatePayload {
  workspace: string;
  language: string;
  sourceLanguage: string;
  viewLanguage: string;
  translations: TranslationInfo[];
  manifest?: { commit?: string; model?: string; generatedAt?: number; catalog?: CatalogNode[] };
  pages: DocsPage[];
  status: DocsStatus;
  mindmap?: { exists: boolean; generatedAt?: number };
  graph: GraphInfo;
}

const EMPTY_STATUS: DocsStatus = { phase: "idle", message: "", done: 0, total: 0, logs: [] };
const EMPTY_GRAPH_STATUS: GraphStatus = { phase: "idle", logs: [] };

const post = (message: Record<string, unknown>) => vscode.postMessage(message);

const LANGUAGE_LABEL: Record<string, string> = { en: "English", "zh-CN": "简体中文" };

const languageLabel = (value: string): string => LANGUAGE_LABEL[value] ?? value;

const PHASE_LABEL: Record<string, string> = {
  idle: t("Idle"),
  scanning: t("Scanning workspace…"),
  catalog: t("Planning the page catalog…"),
  pages: t("Writing pages…"),
  finalizing: t("Finishing…"),
  translating: t("Translating…"),
  mindmap: t("Building the mind map…"),
  done: t("Up to date"),
  error: t("Failed"),
  cancelled: t("Cancelled"),
};

const GRAPH_PHASE_LABEL: Record<string, string> = {
  idle: t("Not generated yet"),
  detecting: t("Looking for graphify…"),
  extracting: t("Extracting code structure…"),
  clustering: t("Clustering communities…"),
  verifying: t("Checking artifacts…"),
  done: t("Ready"),
  error: t("Failed"),
  cancelled: t("Cancelled"),
};

type Tab = "docs" | "graph" | "mindmap";

interface MindNode {
  title: string;
  path?: string;
  children: MindNode[];
}

/** Parse the `#` tree; a `:path` suffix becomes a link to the source file. */
function parseMindMap(markdown: string): MindNode[] {
  const roots: MindNode[] = [];
  const stack: { level: number; node: MindNode }[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(raw.trim());
    if (!match) continue;
    const level = match[1].length;
    let title = match[2];
    let path: string | undefined;
    const colon = title.lastIndexOf(":");
    if (colon > 0) {
      const candidate = title.slice(colon + 1).trim();
      if (candidate && !/\s/.test(candidate) && (candidate.includes("/") || candidate.includes("."))) {
        path = candidate.replace(/\\/g, "/");
        title = title.slice(0, colon).trim();
      }
    }
    if (!title) continue;
    const node: MindNode = { title, path, children: [] };
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
    stack.push({ level, node });
  }
  return roots;
}

/** Flatten the visible tree (collapsed branches removed) into vis-network data. */
function buildMindGraph(
  nodes: MindNode[],
  collapsed: Record<string, boolean>,
): {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  meta: Record<string, { path?: string; hasChildren: boolean }>;
} {
  const out = {
    nodes: [] as Record<string, unknown>[],
    edges: [] as Record<string, unknown>[],
    meta: {} as Record<string, { path?: string; hasChildren: boolean }>,
  };
  const walk = (list: MindNode[], depth: number, parentId?: string): void => {
    list.forEach((node, index) => {
      const id = parentId ? `${parentId}.${index}` : String(index);
      const hasChildren = node.children.length > 0;
      out.meta[id] = { path: node.path, hasChildren };
      out.nodes.push({
        id,
        label: node.title,
        title: node.path ? `${node.title}\n${node.path}` : node.title,
        level: depth,
        shape: "box",
        margin: depth === 0 ? 14 : 10,
        shapeProperties: { borderRadius: 6 },
        widthConstraint: { maximum: 220 },
        color: depth === 0
          ? { background: "#2f4468", border: "#6b9be0", highlight: { background: "#3a5488", border: "#8ab4f8" } }
          : depth === 1
            ? { background: "#243247", border: "#4a5a75", highlight: { background: "#2d3f59", border: "#6b9be0" } }
            : { background: "#1d2534", border: "#38445a", highlight: { background: "#263143", border: "#5b7ba8" } },
        font: { color: depth === 0 ? "#ffffff" : "#d5dbe6", size: depth === 0 ? 13 : depth === 1 ? 12 : 11.5 },
      });
      if (parentId) {
        out.edges.push({
          from: parentId,
          to: id,
          width: depth === 1 ? 1.4 : 1,
          color: { color: "rgba(120,140,175,0.45)" },
        });
      }
      if (hasChildren && !collapsed[id]) walk(node.children, depth + 1, id);
    });
  };
  walk(nodes, 0);
  return out;
}

/**
 * Horizontal mind map. Parent nodes expand or collapse on click; a leaf with a
 * path opens that file in the editor.
 */
function MindMapCanvas({ nodes }: { nodes: MindNode[] }) {
  const container = React.useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const graph = React.useMemo(() => buildMindGraph(nodes, collapsed), [nodes, collapsed]);
  const metaRef = React.useRef(graph.meta);
  metaRef.current = graph.meta;

  React.useEffect(() => {
    const element = container.current;
    if (!element) return;
    const network = new Network(
      element,
      {
        nodes: new DataSet(graph.nodes as unknown as Node[]),
        edges: new DataSet(graph.edges as unknown as Edge[]),
      },
      {
        autoResize: true,
        layout: {
          hierarchical: {
            enabled: true,
            direction: "LR",
            sortMethod: "directed",
            levelSeparation: 230,
            nodeSpacing: 32,
            treeSpacing: 48,
            blockShifting: true,
            edgeMinimization: true,
            parentCentralization: true,
          },
        },
        physics: false,
        nodes: { shape: "box", borderWidth: 1 },
        edges: {
          smooth: { enabled: true, type: "cubicBezier", forceDirection: "horizontal", roundness: 0.45 },
          color: { color: "rgba(120,140,175,0.45)" },
        },
        interaction: { hover: true, tooltipDelay: 200, dragView: true, zoomView: true, keyboard: false },
      },
    );
    network.on("click", (params: { nodes: Array<string | number> }) => {
      const id = params.nodes[0] !== undefined ? String(params.nodes[0]) : undefined;
      if (!id) return;
      const info = metaRef.current[id];
      if (!info) return;
      if (info.hasChildren) setCollapsed((current) => ({ ...current, [id]: !current[id] }));
      else if (info.path) post({ type: "openSource", path: info.path });
    });
    const frame = requestAnimationFrame(() => network.fit());
    return () => {
      cancelAnimationFrame(frame);
      network.destroy();
    };
  }, [graph]);

  return <div className="pd-mindmap-canvas" ref={container} />;
}

function formatTime(value?: number): string {
  if (!value) return "—";
  const date = new Date(value);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function shortPath(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? value : `…/${parts.slice(-2).join("/")}`;
}

/**
 * Render graphify's community-level projection ourselves: its graph.html pulls
 * vis-network from a CDN, which never loads inside the webview sandbox.
 */
function GraphCanvas({ nodes, edges }: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }) {
  const container = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const element = container.current;
    if (!element) return;
    const network = new Network(
      element,
      {
        nodes: new DataSet(nodes as unknown as Node[]),
        edges: new DataSet(edges as unknown as Edge[]),
      },
      {
        autoResize: true,
        layout: { improvedLayout: false },
        nodes: { shape: "dot", borderWidth: 1, font: { color: "#dcdcdc", size: 12 } },
        edges: { smooth: false },
        interaction: { hover: true, tooltipDelay: 150, keyboard: false },
        physics: {
          stabilization: { iterations: 150, fit: true },
          barnesHut: { gravitationalConstant: -14000, springLength: 140, avoidOverlap: 0.2 },
        },
      },
    );
    network.once("stabilizationIterationsDone", () => {
      network.setOptions({ physics: false });
      network.fit();
    });
    return () => network.destroy();
  }, [nodes, edges]);
  return <div className="pd-graph-canvas" ref={container} />;
}

export function App() {
  const [state, setState] = React.useState<StatePayload | undefined>();
  const [tab, setTab] = React.useState<Tab>("docs");
  const [selected, setSelected] = React.useState<string | undefined>();
  const [contents, setContents] = React.useState<Record<string, string>>({});
  const [pageError, setPageError] = React.useState<string | undefined>();
  const [logsOpen, setLogsOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [actionError, setActionError] = React.useState<string | undefined>();
  const [notice, setNotice] = React.useState<string | undefined>();
  const [graphData, setGraphData] = React.useState<{ nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } | undefined>();
  const [graphError, setGraphError] = React.useState<string | undefined>();
  const [graphLoading, setGraphLoading] = React.useState(false);
  const [mindmapText, setMindmapText] = React.useState<string | undefined>();
  const [mindmapError, setMindmapError] = React.useState<string | undefined>();
  const [mindmapLoading, setMindmapLoading] = React.useState(false);

  React.useEffect(() => {
    const listener = (event: MessageEvent) => {
      const message = event.data as Record<string, any>;
      switch (message.type) {
        case "state": {
          const next = message as unknown as StatePayload;
          setState(next);
          setSelected((current) => {
            if (current && next.pages.some((page) => page.slug === current)) return current;
            return next.pages.find((page) => page.exists)?.slug ?? next.pages[0]?.slug;
          });
          break;
        }
        case "docsStatus":
          setState((current) => current ? { ...current, status: message.status } : current);
          break;
        case "graphifyStatus":
          setState((current) => current ? { ...current, graph: { ...current.graph, status: message.status } } : current);
          break;
        case "pageContent":
          setContents((current) => ({ ...current, [`${message.language ?? ""}:${message.slug}`]: message.markdown }));
          setPageError(undefined);
          break;
        case "pageError":
          setPageError(message.error);
          break;
        case "graphData":
          setGraphLoading(false);
          if (typeof message.error === "string") {
            setGraphError(message.error);
            setGraphData(undefined);
          } else {
            setGraphError(undefined);
            setGraphData({ nodes: message.nodes ?? [], edges: message.edges ?? [] });
          }
          break;
        case "mindmapContent":
          setMindmapLoading(false);
          setMindmapError(undefined);
          setMindmapText(typeof message.markdown === "string" ? message.markdown : "");
          break;
        case "mindmapError":
          setMindmapLoading(false);
          setMindmapError(message.error);
          break;
        case "actionError":
          setActionError(message.error);
          break;
        case "exportDone":
          setNotice(message.ok ? t("Exported {count} pages to docs/", { count: message.files }) : message.error);
          break;
      }
    };
    window.addEventListener("message", listener);
    post({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, []);

  const pages = state?.pages ?? [];
  const status = state?.status ?? EMPTY_STATUS;
  const running = ["scanning", "catalog", "pages", "finalizing", "translating", "mindmap"].includes(status.phase);
  const mindmapRunning = status.phase === "mindmap";
  const mindmapInfo = state?.mindmap;
  const viewLanguage = state?.viewLanguage ?? state?.sourceLanguage ?? "en";
  const sourceLanguage = state?.sourceLanguage ?? "en";
  const translations = state?.translations ?? [];
  const translateTarget = sourceLanguage === "zh-CN" ? "en" : "zh-CN";
  const currentTranslation = translations.find((item) => item.language === viewLanguage);
  const viewingTranslation = viewLanguage !== sourceLanguage;
  const graph = state?.graph;
  const graphStatus = graph?.status ?? EMPTY_GRAPH_STATUS;
  const graphRunning = ["detecting", "extracting", "clustering", "verifying"].includes(graphStatus.phase);

  // A finished run rewrote graph.html; drop the previous projection first.
  React.useEffect(() => {
    if (graphStatus.phase !== "done") return;
    setGraphData(undefined);
    setGraphError(undefined);
    setGraphLoading(false);
  }, [graphStatus.phase, graphStatus.finishedAt]);

  // The projection is large, so it is fetched only when the graph tab is open.
  React.useEffect(() => {
    if (tab !== "graph" || !graph?.hasArtifacts) return;
    if (graphData || graphLoading || graphError) return;
    setGraphLoading(true);
    post({ type: "readGraph" });
  }, [tab, graph?.hasArtifacts, graphData, graphLoading, graphError]);

  // A new run replaces mindmap.md; drop the cached tree while it is being built.
  React.useEffect(() => {
    if (!mindmapRunning) return;
    setMindmapText(undefined);
    setMindmapError(undefined);
    setMindmapLoading(false);
  }, [mindmapRunning]);

  // The tree is fetched only when the tab is open and the file exists.
  React.useEffect(() => {
    if (tab !== "mindmap" || !mindmapInfo?.exists || mindmapRunning) return;
    if (mindmapText !== undefined || mindmapLoading || mindmapError) return;
    setMindmapLoading(true);
    post({ type: "readMindmap" });
  }, [tab, mindmapInfo?.exists, mindmapInfo?.generatedAt, mindmapRunning, mindmapText, mindmapLoading, mindmapError]);

  const mindmapRoots = React.useMemo(() => (mindmapText ? parseMindMap(mindmapText) : []), [mindmapText]);
  const mindmapNodeCount = React.useMemo(() => {
    const count = (list: MindNode[]): number => list.reduce((sum, node) => sum + 1 + count(node.children), 0);
    return count(mindmapRoots);
  }, [mindmapRoots]);

  const groups = React.useMemo(() => {
    const map = new Map<string, DocsPage[]>();
    for (const page of pages) {
      const list = map.get(page.group) ?? [];
      list.push(page);
      map.set(page.group, list);
    }
    return [...map.entries()];
  }, [pages]);

  const catalog = state?.manifest?.catalog ?? [];
  const pageBySlug = React.useMemo(() => new Map(pages.map((page) => [page.slug, page])), [pages]);

  const toggleNode = (path: string) => setCollapsed((current) => ({ ...current, [path]: !current[path] }));

  const renderNode = (node: CatalogNode, depth: number): React.ReactNode => {
    if (node.children.length > 0) {
      const isCollapsed = !!collapsed[node.path];
      return (
        <div key={node.path} className="pd-node">
          <button
            className="pd-node-title"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => toggleNode(node.path)}
            title={node.title}
          >
            <span className={"pd-twisty" + (isCollapsed ? "" : " open")}>
              <Icon name="chevR" size={11} />
            </span>
            <span className="pd-node-title-text">{node.title}</span>
            <span className="pd-node-count">{node.children.length}</span>
          </button>
          {!isCollapsed && (
            <div className="pd-node-children">
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }
    const page = pageBySlug.get(node.path);
    if (!page) return null;
    return (
      <button
        key={node.path}
        className={"pd-page-item" + (selected === page.slug ? " active" : "")}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => setSelected(page.slug)}
        title={page.description}
      >
        <Icon name="fileCode" size={12} />
        <span className="pd-page-title">{page.title}</span>
        <span className={"pd-page-state " + (page.exists ? "ready" : "pending")}>
          {page.exists ? t("Ready") : t("Pending")}
        </span>
      </button>
    );
  };

  const current = pages.find((page) => page.slug === selected);
  const currentMarkdown = current ? contents[`${viewLanguage}:${current.slug}`] : undefined;

  React.useEffect(() => {
    if (!current || contents[`${viewLanguage}:${current.slug}`]) return;
    post({ type: "readPage", slug: current.slug, language: viewLanguage });
  }, [current?.slug, current?.exists, contents, viewLanguage]);

  // Switching language must not show the previous language's error banner.
  React.useEffect(() => {
    setPageError(undefined);
  }, [viewLanguage]);

  // A finished run invalidates cached markdown for pages that were rewritten.
  const phase = status.phase;
  React.useEffect(() => {
    if (phase === "done") setContents({});
  }, [phase]);

  const generated = pages.filter((page) => page.exists).length;

  return (
    <div className="pd-root">
      <header className="pd-toolbar">
        <div className="pd-toolbar-row">
          <div className="pd-crumbs">{t("AiWorkHarness")} <span>/</span> {t("Project Docs")}</div>
          <span className="pd-chip" title={state?.workspace}>{shortPath(state?.workspace ?? "")}</span>
          {state?.manifest?.commit && <span className="pd-chip"><span className="pd-chip-key">commit</span>{state.manifest.commit}</span>}
          <span className="pd-chip">{t("{done} of {total} pages", { done: generated, total: pages.length || 0 })}</span>
          <span className="pd-spacer" />
          <button className="pd-btn ghost" onClick={() => setLogsOpen((value) => !value)}>
            <Icon name="fileCode" size={13} /> {logsOpen ? t("Hide logs") : t("View logs")}
          </button>
          <button className="pd-btn ghost" onClick={() => post({ type: "docPrompts" })}>
            <Icon name="ruler" size={13} /> {t("Prompts")}
          </button>
          {(translations.length > 0 || state?.manifest) && (
            <select
              className="pd-select"
              value={viewLanguage}
              disabled={running}
              title={t("Documentation language")}
              onChange={(event) => post({ type: "setLanguage", language: event.target.value })}
            >
              <option value={sourceLanguage}>{languageLabel(sourceLanguage)}</option>
              {translations.map((item) => (
                <option key={item.language} value={item.language}>
                  {languageLabel(item.language)}{item.stale ? ` · ${t("Outdated")}` : ""}
                </option>
              ))}
            </select>
          )}
          {state?.manifest && (
            <button
              className="pd-btn ghost"
              disabled={running}
              onClick={() => post({ type: "translate", language: translateTarget })}
            >
              <Icon name="globe" size={13} /> {currentTranslation
                ? t("Update {language} translation", { language: languageLabel(translateTarget) })
                : t("Translate to {language}", { language: languageLabel(translateTarget) })}
            </button>
          )}
          <button className="pd-btn ghost" disabled={running || !pages.length} onClick={() => post({ type: "export" })}>
            <Icon name="download" size={13} /> {t("Export to docs/")}
          </button>
          <button className="pd-btn ghost" disabled={running || !pages.length} onClick={() => post({ type: "generate", mode: "incremental" })}>
            <Icon name="history" size={13} /> {t("Update")}
          </button>
          {running
            ? <button className="pd-btn danger" onClick={() => post({ type: "cancel" })}>{t("Cancel")}</button>
            : <button className="pd-btn primary" onClick={() => post({ type: "generate", mode: "full" })}>
                <Icon name="play" size={13} /> {t("Generate")}
              </button>}
        </div>
        <div className="pd-tabs">
          <button className={"pd-tab" + (tab === "docs" ? " active" : "")} onClick={() => setTab("docs")}>{t("Documentation")}</button>
          <button className={"pd-tab" + (tab === "graph" ? " active" : "")} onClick={() => setTab("graph")}>{t("Knowledge Graph")}</button>
          <button className={"pd-tab" + (tab === "mindmap" ? " active" : "")} onClick={() => setTab("mindmap")}>{t("Mind Map")}</button>
          <span className="pd-spacer" />
          {tab === "docs" && state?.manifest && (
            <span className="pd-meta">{t("Last generated {time}", { time: formatTime(state.manifest.generatedAt) })}</span>
          )}
          {tab === "docs" && viewingTranslation && currentTranslation?.stale && (
            <span className="pd-chip warn">{t("Translation is out of date")}</span>
          )}
          {tab === "graph" && graph?.hasArtifacts && <span className="pd-meta">{t("Source: graph.json")}</span>}
          {tab === "mindmap" && mindmapInfo?.generatedAt && (
            <span className="pd-meta">{t("Last generated {time}", { time: formatTime(mindmapInfo.generatedAt) })}</span>
          )}
        </div>
      </header>

      {(actionError || notice) && (
        <div className={"pd-banner" + (actionError ? " error" : "")}>
          <span>{actionError ?? notice}</span>
          <button className="pd-btn ghost" onClick={() => { setActionError(undefined); setNotice(undefined); }}>{t("Dismiss")}</button>
        </div>
      )}

      {tab === "docs" ? (
        <>
          <div className="pd-status">
            {running ? <span className="pd-spinner" /> : <span className={"pd-dot " + status.phase} />}
            <span className="pd-status-text">
              {running && (status.phase === "pages" || status.phase === "translating") && status.page
                ? status.phase === "translating"
                  ? t("Translating {page}", { page: status.page })
                  : t("Writing {page}", { page: status.page })
                : PHASE_LABEL[status.phase] ?? status.phase}
            </span>
            {status.total > 0 && (
              <>
                <div className="pd-progress"><i style={{ width: `${Math.round((status.done / Math.max(status.total, 1)) * 100)}%` }} /></div>
                <span className="pd-status-count">{status.done} / {status.total}</span>
              </>
            )}
            {status.error && <span className="pd-status-error" title={status.error}>{status.error}</span>}
          </div>

          <div className="pd-body">
            <nav className="pd-nav">
              {pages.length === 0 && <div className="pd-nav-empty">{t("No pages yet. Generate the documentation to get started.")}</div>}
              {catalog.length > 0
                ? catalog.map((node) => renderNode(node, 0))
                : groups.map(([group, groupPages]) => (
                    <div key={group} className="pd-group">
                      <div className="pd-group-title">{group}</div>
                      {groupPages.map((page) => (
                        <button
                          key={page.slug}
                          className={"pd-page-item" + (page.slug === selected ? " active" : "")}
                          onClick={() => setSelected(page.slug)}
                          title={page.description}
                        >
                          <Icon name="fileCode" size={12} />
                          <span className="pd-page-title">{page.title}</span>
                          <span className={"pd-page-state " + (page.exists ? "ready" : "pending")}>
                            {page.exists ? t("Ready") : t("Pending")}
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
            </nav>

            <section className="pd-doc">
              {current ? (
                <>
                  <div className="pd-doc-head">
                    <div>
                      <div className="pd-doc-meta">{current.group} · <code>{current.slug}.md</code></div>
                      <h1>{current.title}</h1>
                      <p className="pd-doc-desc">{current.description}</p>
                    </div>
                    <button
                      className="pd-btn ghost"
                      disabled={running || !current.exists || viewingTranslation}
                      onClick={() => post({ type: "regeneratePage", slug: current.slug })}
                    >
                      <Icon name="reset" size={13} /> {t("Regenerate this page")}
                    </button>
                  </div>
                  <div className="pd-doc-body">
                    {pageError && <div className="pd-empty">{pageError}</div>}
                    {!pageError && currentMarkdown && <div className="pd-md"><MermaidMarkdown text={currentMarkdown} /></div>}
                    {!pageError && !currentMarkdown && (
                      <div className="pd-empty">
                        {current.exists
                          ? t("Loading…")
                          : viewingTranslation ? t("This page has not been translated yet.") : t("This page has not been generated yet.")}
                        {!current.exists && !running && !viewingTranslation && (
                          <button className="pd-btn secondary" onClick={() => post({ type: "generate", mode: "full" })}>{t("Generate documentation")}</button>
                        )}
                        {!current.exists && !running && viewingTranslation && (
                          <button className="pd-btn secondary" onClick={() => post({ type: "translate", language: viewLanguage })}>
                            {t("Translate to {language}", { language: languageLabel(viewLanguage) })}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="pd-empty">
                  {t("No documentation yet.")}
                  <button className="pd-btn primary" disabled={running} onClick={() => post({ type: "generate", mode: "full" })}>{t("Generate documentation")}</button>
                </div>
              )}
            </section>
          </div>

          {logsOpen && (
            <div className="pd-logs">
              {status.logs.length === 0 && <div className="pd-log-line muted">{t("No log output yet.")}</div>}
              {status.logs.slice(-120).map((line, index) => (
                <div key={index} className={"pd-log-line" + (line.startsWith("!") ? " warn" : line.startsWith("✓") ? " ok" : "")}>{line}</div>
              ))}
            </div>
          )}
        </>
      ) : tab === "graph" ? (
        <>
          <div className="pd-status">
            {graphRunning ? <span className="pd-spinner" /> : <span className={"pd-dot " + graphStatus.phase} />}
            <span className="pd-status-text">
              {GRAPH_PHASE_LABEL[graphStatus.phase] ?? graphStatus.phase}
              {graphStatus.error ? ` — ${graphStatus.error}` : ""}
            </span>
            <span className="pd-spacer" />
            {graph?.available
              ? <span className="pd-chip">{t("graphify detected")}</span>
              : <span className="pd-chip warn">{t("graphify not found")}</span>}
            {graphRunning
              ? <button className="pd-btn danger" onClick={() => post({ type: "cancelGraph" })}>{t("Cancel")}</button>
              : <button className="pd-btn primary" onClick={() => post({ type: "generateGraph" })}><Icon name="play" size={13} /> {t("Generate graph")}</button>}
          </div>

          <div className="pd-graph">
            {graph?.hasArtifacts
              ? graphData
                ? <GraphCanvas nodes={graphData.nodes} edges={graphData.edges} />
                : graphError
                  ? (
                    <div className="pd-empty graph">
                      <Icon name="database" size={26} />
                      <div className="pd-empty-title">{t("Could not read the knowledge graph")}</div>
                      <div className="pd-empty-text">{graphError}</div>
                      <button className="pd-btn secondary" onClick={() => post({ type: "openGraphHtml" })}>
                        {t("Open graph.html in browser")}
                      </button>
                    </div>
                  )
                  : (
                    <div className="pd-empty graph">
                      <span className="pd-spinner" />
                      <div className="pd-empty-text">{t("Loading graph…")}</div>
                    </div>
                  )
              : (
                <div className="pd-empty graph">
                  <Icon name="database" size={26} />
                  <div className="pd-empty-title">{t("No knowledge graph yet")}</div>
                  <div className="pd-empty-text">
                    {graph?.available
                      ? t("Generate a graph from the current workspace with the external graphify CLI (extract + cluster-only).")
                      : t("graphify was not found on PATH. Install it, or set aiworkharness.graphifyPath in settings.")}
                  </div>
                  {!graph?.available && (
                    <>
                      <button className="pd-btn secondary" onClick={() => post({ type: "openGraphifySetting" })}>
                        {t("Set graphify path")}
                      </button>
                      <button className="pd-btn ghost" onClick={() => post({ type: "openExternal", url: "https://github.com/search?q=graphify+code+graph&type=repositories" })}>
                        {t("Learn more")}
                      </button>
                    </>
                  )}
                </div>
              )}
          </div>

          <div className="pd-graph-footer">
            <span>{t("Artifacts: graph.json · graph.html · GRAPH_REPORT.md")}</span>
            {graphData && <span className="pd-meta">{t("{nodes} nodes · {edges} edges", { nodes: String(graphData.nodes.length), edges: String(graphData.edges.length) })}</span>}
            <span className="pd-spacer" />
            {graph?.hasArtifacts && (
              <button className="pd-btn ghost" onClick={() => post({ type: "openGraphHtml" })}>
                {t("Open graph.html in browser")}
              </button>
            )}
            {graphStatus.logs.length > 0 && <span className="pd-meta">{graphStatus.logs[graphStatus.logs.length - 1]}</span>}
          </div>
        </>
      ) : (
        <>
          <div className="pd-status">
            {mindmapRunning ? <span className="pd-spinner" /> : <span className={"pd-dot " + status.phase} />}
            <span className="pd-status-text">
              {mindmapRunning
                ? PHASE_LABEL.mindmap
                : mindmapInfo?.exists ? t("Architecture mind map") : t("Not generated yet")}
              {!mindmapRunning && status.phase === "error" && status.error ? ` — ${status.error}` : ""}
            </span>
            <span className="pd-spacer" />
            {mindmapInfo?.exists && mindmapNodeCount > 0 && (
              <>
                <span className="pd-chip">{t("{count} nodes", { count: mindmapNodeCount })}</span>
                <span className="pd-meta">{t("Click a parent to expand or collapse; leaf nodes open the source file.")}</span>
              </>
            )}
            {mindmapRunning
              ? <button className="pd-btn danger" onClick={() => post({ type: "cancel" })}>{t("Cancel")}</button>
              : <button className="pd-btn primary" disabled={running} onClick={() => post({ type: "generateMindmap" })}>
                  <Icon name="play" size={13} /> {mindmapInfo?.exists ? t("Regenerate mind map") : t("Generate mind map")}
                </button>}
          </div>

          <div className="pd-mindmap-body">
            {mindmapError ? (
              <div className="pd-empty">{mindmapError}</div>
            ) : mindmapRunning && mindmapRoots.length === 0 ? (
              <div className="pd-empty">
                <span className="pd-spinner" />
                <div className="pd-empty-text">{t("Building the mind map…")}</div>
              </div>
            ) : !mindmapInfo?.exists ? (
              <div className="pd-empty">
                <Icon name="gitBranch" size={26} />
                <div className="pd-empty-title">{t("No mind map yet")}</div>
                <div className="pd-empty-text">
                  {t("Generate a three-level architecture mind map from the current workspace. Nodes with a path open the source file.")}
                </div>
                <button className="pd-btn primary" disabled={running} onClick={() => post({ type: "generateMindmap" })}>
                  {t("Generate mind map")}
                </button>
              </div>
            ) : mindmapRoots.length > 0 ? (
              <MindMapCanvas nodes={mindmapRoots} />
            ) : (
              <div className="pd-empty">
                {mindmapLoading ? t("Reading mind map…") : t("The mind map is empty. Regenerate it.")}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
