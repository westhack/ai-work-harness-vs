/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { vscode } from "../../shared/vscode";
import { t as tr } from "../../shared/i18n";

type MarketSource = "skills.sh" | "skillhub.cn";
type MarketSort = "popular" | "trending";

interface MarketSkill {
  id: string;
  source: MarketSource;
  name: string;
  description?: string;
  author?: string;
  installs?: number;
  version?: string;
  pageUrl: string;
  installable: boolean;
}

interface InstallState {
  ok: boolean;
  detail?: string;
  path?: string;
}

interface DetailState {
  loading?: boolean;
  detail?: {
    description: string;
    author?: string;
    version?: string;
    downloads?: number;
    stars?: number;
    category?: string;
    updatedAt?: string;
    sourceUrl?: string;
    readme: string;
  };
  error?: string;
}

const SOURCES: { id: MarketSource; label: string }[] = [
  { id: "skills.sh", label: "skills.sh" },
  { id: "skillhub.cn", label: "SkillHub" },
];

const SORTS: { id: MarketSort; label: string }[] = [
  { id: "popular", label: "Popular" },
  { id: "trending", label: "Trending" },
];

function compact(value: number | undefined): string {
  if (!value) return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export function SkillMarketPanel() {
  const [source, setSource] = React.useState<MarketSource>("skills.sh");
  const [sort, setSort] = React.useState<MarketSort>("popular");
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<MarketSkill[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [error, setError] = React.useState("");
  const [installing, setInstalling] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<string[]>([]);
  const [done, setDone] = React.useState<Record<string, InstallState>>({});
  const [detail, setDetail] = React.useState<Record<string, DetailState>>({});
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const requestId = React.useRef("");
  const activeQuery = React.useRef("");

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "skillMarketResults") {
        if (msg.requestId && msg.requestId !== requestId.current) return;
        const nextPage = Number(msg.page) || 1;
        const incoming: MarketSkill[] = Array.isArray(msg.results) ? msg.results : [];
        setBusy(false);
        setLoaded(true);
        setPage(nextPage);
        setHasMore(!!msg.hasMore);
        setResults((prev) => {
          if (nextPage <= 1) return incoming;
          const seen = new Set(prev.map((item) => `${item.source}:${item.id}`));
          return [...prev, ...incoming.filter((item) => !seen.has(`${item.source}:${item.id}`))];
        });
        setError(typeof msg.error === "string" ? msg.error : "");
      } else if (msg.type === "skillMarketDetail") {
        const key = `${String(msg.source ?? "skills.sh")}:${String(msg.id ?? "")}`;
        setDetail((prev) => ({ ...prev, [key]: { loading: false, detail: msg.detail, error: msg.error } }));
      } else if (msg.type === "skillMarketInstallStarted") {
        setInstalling(String(msg.id ?? ""));
        setLog([]);
      } else if (msg.type === "skillMarketInstallProgress") {
        setLog((prev) => [...prev, String(msg.line ?? "")].slice(-120));
      } else if (msg.type === "skillMarketInstallDone") {
        setInstalling(null);
        setDone((prev) => ({
          ...prev,
          [String(msg.id ?? "")]: { ok: !!msg.ok, detail: msg.detail, path: msg.path },
        }));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const send = (requestPage: number, keyword: string, replace: boolean) => {
    setBusy(true);
    if (replace) {
      setLoaded(false);
      setResults([]);
      setError("");
    }
    if (keyword) {
      vscode.postMessage({ type: "searchSkillMarket", source, query: keyword, requestId: requestId.current, sort, page: requestPage });
    } else {
      vscode.postMessage({ type: "listSkillMarket", source, sort, page: requestPage, requestId: requestId.current });
    }
  };

  // Show a popular feed immediately; typing a keyword replaces it.
  React.useEffect(() => {
    activeQuery.current = "";
    requestId.current = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setPage(1);
    send(1, "", true);
  }, [source, sort]);

  const submit = () => {
    const keyword = query.trim();
    if (!keyword || busy) return;
    activeQuery.current = keyword;
    requestId.current = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setPage(1);
    send(1, keyword, true);
  };

  const loadMore = () => {
    if (busy || !hasMore) return;
    send(page + 1, activeQuery.current, false);
  };

  const toggleDetail = (skill: MarketSkill) => {
    const key = `${skill.source}:${skill.id}`;
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    const existing = detail[key];
    if (existing && !existing.error) return;
    setDetail((prev) => ({ ...prev, [key]: { loading: true } }));
    vscode.postMessage({ type: "getSkillMarketDetail", entry: skill });
  };

  const pickSource = (next: MarketSource) => {
    setSource(next);
    setQuery("");
  };

  const pickSort = (next: MarketSort) => {
    if (next === sort) return;
    setSort(next);
    setQuery("");
  };

  return (
    <>
      <h1 className="page-title" style={{ marginBottom: 4 }}>{tr("Skill Market")}</h1>
      <p className="panel-hint" style={{ marginBottom: 20 }}>
        {tr("Search public skill registries and install them into your global skills folder.")}
      </p>

      <div className="sub-tabs" role="tablist" style={{ marginBottom: 12 }}>
        {SOURCES.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={source === item.id}
            className={source === item.id ? "active" : ""}
            onClick={() => pickSource(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="panel-actions" style={{ marginBottom: 12 }}>
        <div className="sub-tabs" role="tablist" style={{ margin: 0, marginRight: 8 }}>
          {SORTS.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={sort === item.id}
              className={sort === item.id ? "active" : ""}
              onClick={() => pickSort(item.id)}
            >
              {tr(item.id === "popular" ? "Popular" : "Trending")}
            </button>
          ))}
        </div>
        <input
          style={{ flex: 1 }}
          value={query}
          placeholder={tr("Search skills…")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
        />
        <button className="btn-primary" disabled={busy || !query.trim()} onClick={submit}>
          {busy ? tr("Searching…") : tr("Search")}
        </button>
      </div>

      <p className="panel-hint">{tr("Installed skills are written to ~/.aiworkharness/skills and appear under Rules & Skills.")}</p>

      {error && <div className="fc-error" role="alert">{error}</div>}

      {loaded && !busy && results.length === 0 && !error && (
        <div className="rss-empty">
          <div className="rss-empty-title">{tr("No results")}</div>
          <div className="rss-empty-sub">{tr("Try a different keyword or switch the source")}</div>
        </div>
      )}

      {results.length > 0 && (
        <div className="rss-list">
          {results.map((skill) => {
            const key = `${skill.source}:${skill.id}`;
            const installState = done[skill.id];
            const detailState = detail[key];
            const isInstalling = installing === skill.id;
            return (
              <React.Fragment key={key}>
                <div className="rss-row" style={{ cursor: "default" }}>
                  <div className="lr-text">
                    <div className="lr-title">
                      {skill.name}{" "}
                      {skill.installs ? <span className="badge-tag glob">{compact(skill.installs)}</span> : null}
                    </div>
                    <div className="lr-desc rss-clamp">
                      {skill.description || skill.author || skill.id}
                    </div>
                    {installState?.detail && !installState.ok && <div className="row-desc engine-status-error">{installState.detail}</div>}
                    {installState?.ok && (
                      <div className="row-desc">{tr("Installed to")}: {installState.path}</div>
                    )}
                  </div>
                  <button
                    className="btn-ghost sm"
                    title={tr("Details")}
                    onClick={() => toggleDetail(skill)}
                  >
                    {expanded === key ? tr("Hide details") : tr("Details")}
                  </button>
                  <button
                    className="btn-ghost sm"
                    title={tr("Open page")}
                    onClick={() => vscode.postMessage({ type: "openExternal", url: skill.pageUrl })}
                  >
                    {tr("Open page")}
                  </button>
                  <button
                    className="btn-secondary"
                    disabled={!!installing || !skill.installable || installState?.ok}
                    onClick={() => vscode.postMessage({ type: "installSkillMarket", entry: skill })}
                  >
                    {installState?.ok ? tr("Installed") : isInstalling ? tr("Installing…") : skill.installable ? tr("Install") : tr("Manual")}
                  </button>
                </div>
                {expanded === key && (
                  <div style={{ borderTop: "1px solid rgba(127,127,127,.25)", padding: "10px 14px 14px" }}>
                    {detailState?.loading ? (
                      <div className="row-desc">{tr("Loading…")}</div>
                    ) : detailState?.error ? (
                      <div className="fc-error" role="alert">{detailState.error}</div>
                    ) : detailState?.detail ? (
                      <div>
                        <div style={{ fontSize: 12, lineHeight: 1.7, whiteSpace: "pre-wrap", marginBottom: 10 }}>
                          {detailState.detail.description || tr("No description")}
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                          {detailState.detail.version && <span className="badge-tag">v{detailState.detail.version}</span>}
                          {!!detailState.detail.downloads && <span className="badge-tag">{tr("Downloads")} {compact(detailState.detail.downloads)}</span>}
                          {!!detailState.detail.stars && <span className="badge-tag">{detailState.detail.stars} ★</span>}
                          {detailState.detail.category && <span className="badge-tag">{detailState.detail.category}</span>}
                          {detailState.detail.author && <span className="badge-tag">@{detailState.detail.author}</span>}
                          {detailState.detail.updatedAt && <span className="badge-tag">{tr("Updated")} {detailState.detail.updatedAt}</span>}
                        </div>
                        <div className="row-desc" style={{ marginBottom: 6 }}>{tr("SKILL.md")}</div>
                        <pre style={{ whiteSpace: "pre-wrap", margin: 0, maxHeight: 380, overflow: "auto", fontSize: 12 }}>{detailState.detail.readme}</pre>
                      </div>
                    ) : null}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}

      {results.length > 0 && hasMore && (
        <div className="panel-actions" style={{ marginTop: 12, justifyContent: "center" }}>
          <button className="btn-secondary" disabled={busy} onClick={loadMore}>
            {busy ? tr("Loading…") : tr("Load more")}
          </button>
        </div>
      )}

      {installing && log.length > 0 && (
        <div className="engine-status-log">
          <div className="row-desc">{tr("Installation log")}</div>
          <pre>{log.join("\n")}</pre>
        </div>
      )}
    </>
  );
}
