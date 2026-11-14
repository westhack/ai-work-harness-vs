/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { Select } from "../shared/Select";
import { Icon, IconName } from "../shared/icons";
import { vscode } from "../shared/vscode";
import { ApprovalActionType, ApprovalMode, ApprovalPolicy, DEFAULT_APPROVAL, EMPTY_FEATURES, FeatureConfig, CodeGraphStatus, LlamacppStatus, McpStatus, ModelDef, ModelUsage, OAUTH_LABEL, OAuthStatus, OllamaModel, OllamaStatus, Persona, RuleInfo, SkillInfo, uid } from "./features";
import { HooksPanel, LlamacppPanel, McpPanel, MemoryPanel, ModelsPanel, OAuthAccountCard, OllamaPanel, PersonasPanel, ProvidersPanel, RulesPanel, SkillMarketPanel, SubagentsPanel } from "./FeaturePanels";
import { ModelSelect } from "../shared/ModelSelect";
import { CacheUsage } from "./CacheUsage";
import { DocsSection, type DocSourceInfo, type DocsStatus } from "./DocsSection";
import { ControlLabelContext, Toggle } from "./panels/Toggle";
import { setMotionPreference, type MotionPreference } from "../shared/motionPreference";
import { t as tr, getLocale, setLocale } from "../shared/i18n";
import { LANGUAGE_OPTIONS, type LanguagePreference } from "../../src/shared/i18n";

interface Settings {
  model: string;
  maxResponseLength: number;
  enableWorkspaceContext: boolean;
  enableFileReading: boolean;
  enableTerminalSuggestions: boolean;
  systemPrompt: string;
}

const DEFAULTS: Settings = {
  model: "",
  maxResponseLength: 0,
  enableWorkspaceContext: true,
  enableFileReading: true,
  enableTerminalSuggestions: true,
  systemPrompt: "",
};

type Section = "general" | "usage" | "agents" | "providers" | "models" | "llamacpp" | "ollama" | "behavior" | "personas" | "memory" | "rules" | "skillMarket" | "subagents" | "mcp" | "hooks" | "knowledge" | "indexing" | "advanced" | "about";

interface IndexStatus {
  indexing: boolean;
  paused?: boolean;
  done: number;
  total: number;
  files: number;
  chunks: number;
  model: string;
  backend?: "local" | "remote";
  device?: string | null;
  accelerator?: "gpu" | "cpu" | "remote" | "pending";
  deviceLabel?: string;
  acceleratorId?: string;
  acceleratorError?: string;
  modelRepo?: string;
  modelDtype?: string;
  modelPooling?: string;
  modelDim?: number;
  remoteBaseUrl?: string;
  runtime?: string;
  platform?: string;
  limitReason?: string;
}
interface EmbedModel {
  id: string;
  name: string;
}

interface EngineStatusInfo {
  id: string;
  label: string;
  available: boolean;
  binaryPath?: string;
  source?: "override" | "extension" | "path" | "vscode-extension";
  installScope: "extension" | "global";
  installCommand?: string;
  docsUrl?: string;
  manual: boolean;
  removable?: boolean;
}

/** Where a resolved engine binary came from, labelled in the engine list. */
const ENGINE_SOURCE_LABELS: Record<string, string> = {
  override: "Custom path",
  extension: "Extension folder",
  path: "PATH",
  "vscode-extension": "VS Code extension",
};

interface EngineInstallResult {
  ok: boolean;
  detail?: string;
}

// Group connection, agent, and workspace settings in the navigation rail.
const NAV: { id: Section; label: string; icon: IconName; sep?: boolean }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "providers", label: "Providers", icon: "globe", sep: true },
  { id: "llamacpp", label: "llama.cpp", icon: "database" },
  { id: "ollama", label: "Ollama", icon: "database" },
  { id: "usage", label: "Usage & Quota", icon: "history", sep: true },
  { id: "agents", label: "Agents", icon: "agent" },
  { id: "models", label: "Models", icon: "model" },
  { id: "behavior", label: "Behavior", icon: "tools" },
  { id: "personas", label: "Personas", icon: "bot", sep: true },
  { id: "memory", label: "Memory", icon: "brain" },
  { id: "rules", label: "Rules & Skills", icon: "ruler" },
  { id: "skillMarket", label: "Skill Market", icon: "globe" },
  { id: "subagents", label: "Subagents & Teams", icon: "agent" },
  { id: "mcp", label: "Tools & MCPs", icon: "task" },
  { id: "hooks", label: "Hooks", icon: "infinity" },
  { id: "knowledge", label: "Repo Wiki", icon: "book" },
  { id: "indexing", label: "Indexing & Docs", icon: "database" },
  { id: "advanced", label: "Advanced", icon: "fileCode", sep: true },
  { id: "about", label: "About", icon: "book" },
];

/** Built-in tool hard timeouts (seconds). Keep in sync with src/agent/tools/shared.ts. */
const TOOL_TIMEOUT_DEFAULTS: { name: string; sec: number }[] = [
  { name: "Shell", sec: 45 },
  { name: "AwaitShell", sec: 60 },
  { name: "Grep", sec: 20 },
  { name: "Glob", sec: 20 },
  { name: "FileSearch", sec: 15 },
  { name: "SemanticSearch", sec: 30 },
  { name: "SearchDocs", sec: 25 },
  { name: "ListDir", sec: 10 },
  { name: "Read", sec: 15 },
  { name: "ReadLints", sec: 15 },
  { name: "WebSearch", sec: 20 },
  { name: "WebFetch", sec: 25 },
  { name: "StrReplace", sec: 20 },
  { name: "Write", sec: 20 },
  { name: "Delete", sec: 10 },
  { name: "EditNotebook", sec: 20 },
  { name: "CallMcpTool", sec: 45 },
  { name: "FetchMcpResource", sec: 30 },
  { name: "ListMcpResources", sec: 15 },
  { name: "TodoWrite", sec: 15 },
  { name: "TodoRead", sec: 15 },
  { name: "WritePlan", sec: 10 },
  { name: "SwitchMode", sec: 5 },
];

/** Search terms per section so the nav filter finds settings inside pages too. */
const SECTION_KEYWORDS: Partial<Record<Section, string>> = {
  general: "editor settings keyboard shortcuts notifications privacy chat titles auto judge model completion sound reset animations motion reduced system",
  usage: "tokens quota limits plan usage oauth account rate limit",
  agents: "text size submit ctrl enter max tab count web search fetch context conversation tool timeout shell grep",
  models: "enable disable model catalog reasoning effort thinking context",
  providers: "api key openai anthropic google openrouter oauth custom base url connect",
  behavior: "workspace context file reading terminal tools auto edits approval allow deny ask review policy allowlist denylist commands mcp web",
  personas: "persona system prompt custom",
  memory: "memory remember saved preferences facts project global inject entries",
  rules: "rules skills agents.md always apply glob",
  skillMarket: "skills market registry install search skills.sh skillhub",
  subagents: "subagents teams squad project mode delegate task tool members roster subagent model",
  mcp: "mcp tools servers",
  hooks: "hooks events commands",
  knowledge: "repo wiki knowledge base project docs mind map graphify task models limits",
  indexing: "codebase index embedding docs semantic sync",
  advanced: "system prompt custom instructions",
  about: "about version license author github repository open source mit Yao",
};

/** A group of related settings separated by subtle rules. */
function Group({ children }: { children: React.ReactNode }) {
  return <div className="settings-group">{children}</div>;
}

function NumInput({
  value,
  onChange,
  step,
  min,
  max,
  placeholder,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  step?: string;
  min?: string;
  max?: string;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      placeholder={placeholder}
      value={value == null ? "" : value}
      onChange={(e) => {
        const t = e.target.value.trim();
        onChange(t === "" ? null : Number(t));
      }}
    />
  );
}

function Row({
  title,
  desc,
  stacked,
  children,
}: {
  title: string;
  desc: string;
  stacked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={"row" + (stacked ? " stacked" : "")}>
      <div className="row-text">
        <div className="row-title">{title}</div>
        <div className="row-desc">{desc}</div>
      </div>
      <ControlLabelContext.Provider value={title}>
        {stacked ? children : <div className="row-control">{children}</div>}
      </ControlLabelContext.Provider>
    </div>
  );
}

// ---- Approval policy editor ----

const APPROVAL_ACTIONS: { type: ApprovalActionType; label: string; desc: string; listHint: string; listsSupported: boolean }[] = [
  { type: "shell", label: "Terminal Commands", desc: "Shell commands the agent runs.", listHint: "command or prefix, e.g. git status, pnpm *, rm *", listsSupported: true },
  { type: "edits", label: "File Edits", desc: "Creating and modifying files (Write, StrReplace, notebooks).", listHint: "path glob, e.g. src/**, *.md, package.json", listsSupported: true },
  { type: "delete", label: "File Deletes", desc: "Deleting files.", listHint: "path glob, e.g. dist/**, *.log", listsSupported: true },
  { type: "mcp", label: "MCP Tools", desc: "Tools exposed by connected MCP servers.", listHint: "tool name or prefix, e.g. mcp__github__*", listsSupported: true },
  { type: "web", label: "Web Access", desc: "Web search and URL fetches.", listHint: "url or query pattern, e.g. https://github.com/*", listsSupported: true },
  { type: "outside", label: "Outside Workspace", desc: "Reading or writing files outside the workspace folder.", listHint: "absolute path glob, e.g. C:/Users/me/notes/**", listsSupported: true },
];

const APPROVAL_MODES: { id: ApprovalMode; label: string; desc: string }[] = [
  { id: "allow", label: "Allow", desc: "Run without asking" },
  { id: "review", label: "Auto Review", desc: "Ask only when it looks risky" },
  { id: "ask", label: "Ask", desc: "Prompt every time" },
  { id: "deny", label: "Deny", desc: "Always block" },
];

/** Comma/newline-separated pattern list editor. */
function PatternList({ label, values, hint, onChange }: { label: string; values: string[]; hint: string; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = React.useState("");
  const add = () => {
    const items = draft.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).filter((x) => !values.includes(x));
    if (items.length) onChange([...values, ...items]);
    setDraft("");
  };
  return (
    <div className="fc-field">
      <span>{label}</span>
      {values.length > 0 && (
        <div className="pattern-chips">
          {values.map((v) => (
            <span key={v} className="pattern-chip">
              <code>{v}</code>
              <button className="icon-btn" title={tr("Remove")} onClick={() => onChange(values.filter((x) => x !== v))}>
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="fc-inline-row">
        <input
          type="text"
          value={draft}
          placeholder={hint}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        />
        <button className="btn-ghost sm" disabled={!draft.trim()} onClick={add}>{tr("Add")}</button>
      </div>
    </div>
  );
}

function ApprovalCard({
  action,
  policy,
  onChange,
}: {
  action: (typeof APPROVAL_ACTIONS)[number];
  policy: ApprovalPolicy;
  onChange: (p: ApprovalPolicy) => void;
}) {
  const r = policy[action.type] ?? DEFAULT_APPROVAL[action.type];
  const [open, setOpen] = React.useState(false);
  const patch = (p: Partial<typeof r>) => onChange({ ...policy, [action.type]: { ...r, ...p } });
  const hasLists = (r.allowlist?.length ?? 0) + (r.denylist?.length ?? 0) > 0;
  return (
    <div className="feature-card">
      <div className="fc-head" style={{ cursor: "pointer" }} onClick={() => setOpen((v) => !v)}>
        <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name={open ? "chevD" : "chevR"} size={14} />
          <span>{tr(action.label)}</span>
          {hasLists && <span className="badge-tag glob">{(r.allowlist?.length ?? 0) + (r.denylist?.length ?? 0)} rules</span>}
        </div>
        <Select
          aria-label={tr(action.label)}
          value={r.mode}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => patch({ mode: e.target.value as ApprovalMode })}
          className={"approval-mode " + r.mode}
        >
          {APPROVAL_MODES.map((m) => (
            <option key={m.id} value={m.id}>{tr(m.label)}</option>
          ))}
        </Select>
      </div>
      {open && (
        <div className="fc-body">
          <p className="panel-hint" style={{ margin: 0 }}>
            {tr(action.desc)} {tr("Currently:")} <strong>{tr(APPROVAL_MODES.find((m) => m.id === r.mode)?.desc ?? "")}</strong>. {tr("Deny list always blocks; allow list always runs — both override the mode.")}
          </p>
          {action.listsSupported && (
            <>
              <PatternList label={tr("Allow list (always run)")} values={r.allowlist ?? []} hint={action.listHint} onChange={(v) => patch({ allowlist: v })} />
              <PatternList label={tr("Deny list (always block)")} values={r.denylist ?? []} hint={action.listHint} onChange={(v) => patch({ denylist: v })} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function UsagePanel({
  usage,
  oauthStatus,
  features,
  setFeatures,
}: {
  usage: Record<string, ModelUsage>;
  oauthStatus: OAuthStatus;
  features: FeatureConfig;
  setFeatures: (p: Partial<FeatureConfig>) => void;
}) {
  const [pending, setPending] = React.useState<"refresh" | "reset">();
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean }>();
  const [quotaRefresh, setQuotaRefresh] = React.useState(0);
  const actionRef = React.useRef<{ requestId: string; action: "refresh" | "reset"; timer: number } | undefined>(undefined);
  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      const active = actionRef.current;
      if (message?.type !== "usageActionResult" || !active || message.requestId !== active.requestId || message.action !== active.action) return;
      if (!["success", "cancelled", "error"].includes(message.status)) return;
      window.clearTimeout(active.timer);
      actionRef.current = undefined;
      setPending(undefined);
      setNotice(message.status === "error"
        ? { text: message.error || tr("The usage action failed. Try again."), error: true }
        : { text: message.status === "cancelled" ? tr("Usage reset cancelled.") : active.action === "reset" ? tr("Recorded usage reset.") : tr("Local usage refreshed. Account quota results are shown below.") });
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      if (actionRef.current) window.clearTimeout(actionRef.current.timer);
      actionRef.current = undefined;
    };
  }, []);
  const runAction = (action: "refresh" | "reset") => {
    if (actionRef.current) return;
    const requestId = uid("usage");
    const timer = window.setTimeout(() => {
      if (actionRef.current?.requestId !== requestId) return;
      actionRef.current = undefined;
      setPending(undefined);
      setNotice({ text: "No response received. Refresh to check the current usage before trying again.", error: true });
    }, 30_000);
    actionRef.current = { requestId, action, timer };
    setPending(action);
    setNotice(undefined);
    if (action === "refresh") setQuotaRefresh(value => value + 1);
    vscode.postMessage({ type: action === "refresh" ? "getUsage" : "resetUsage", requestId });
  };
  const rows = Object.entries(usage).sort((a, b) => b[1].lastUsed - a[1].lastUsed);
  const totals = rows.reduce(
    (t, [, u]) => ({ p: t.p + u.promptTokens, c: t.c + u.completionTokens, r: t.r + u.requests }),
    { p: 0, c: 0, r: 0 }
  );
  const max = Math.max(1, ...rows.map(([, u]) => u.promptTokens + u.completionTokens));
  return (
    <>
      <h1 className="page-title">{tr("Usage & Quota")}</h1>

      <div className="section-label">{tr("Token Usage")}</div>
      <div className="index-card">
        <div className="index-card-title">{tr("Total")}</div>
        <p className="row-desc">
          {fmtTokens(totals.p)} {tr("input ·")} {fmtTokens(totals.c)} {tr("output tokens across")} {totals.r} {tr("request attempt")}{totals.r === 1 ? "" : "s"} {tr("with reported usage. Includes billed retries. Tracked locally on this machine.")}
        </p>
        {rows.length === 0 ? (
          <div className="empty-card" style={{ marginTop: 12 }}>{tr("No usage recorded yet. Start chatting to see per-model token usage.")}</div>
        ) : (
          <div style={{ marginTop: 14 }}>
            {rows.map(([model, u]) => {
              const total = u.promptTokens + u.completionTokens;
              return (
                <div key={model} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, gap: 12 }}>
                    <span style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model}</span>
                    <span className="row-desc" style={{ flex: "0 0 auto" }}>
                      {fmtTokens(u.promptTokens)} {tr("in ·")} {fmtTokens(u.completionTokens)} {tr("out ·")} {u.requests} req
                    </span>
                  </div>
                  <div className="row-desc" style={{ marginBottom: 4 }}><CacheUsage usage={u} /></div>
                  <div className="index-bar"><div className="index-bar-fill" style={{ width: `${Math.max(2, Math.round((total / max) * 100))}%` }} /></div>
                </div>
              );
            })}
          </div>
        )}
        <div className="index-actions">
          <button className="btn-secondary" disabled={!!pending} onClick={() => runAction("refresh")}>
            <Icon name="reset" /> {pending === "refresh" ? "Refreshing…" : "Refresh"}
          </button>
          <button
            className="btn-secondary danger"
            disabled={rows.length === 0 || !!pending}
            onClick={() => runAction("reset")}
          >
            <Icon name="trash" /> {pending === "reset" ? "Awaiting reset…" : "Reset Usage"}
          </button>
        </div>
        {notice && <p className="row-desc" role={notice.error ? "alert" : "status"}>{notice.text}</p>}
      </div>

      <Group>
        <Row title={tr("Track Usage")} desc={tr("Record per-model token usage locally. No data ever leaves your machine.")}>
          <Toggle checked={features.trackUsage !== false} onChange={(v) => setFeatures({ trackUsage: v })} />
        </Row>
      </Group>

      <div className="section-label">{tr("Account Quota")}</div>
      <p className="panel-hint">{tr("Rate-limit windows for your connected OAuth accounts (")}{oauthStatus.accounts.map((a) => OAUTH_LABEL[a.kind]).join(", ") || tr("none connected")}).</p>
      {oauthStatus.accounts.length === 0 ? (
        <div className="empty-card">
          {tr("No OAuth accounts connected. Add one in the")} <strong>{tr("Providers → OAuth Accounts")}</strong> {tr("tab to see its quota here.")}
        </div>
      ) : (
        oauthStatus.accounts.map((a) => <OAuthAccountCard key={a.id} account={a} defaultOpen refreshToken={quotaRefresh} />)
      )}
    </>
  );
}

/** Provider models usable for embeddings (id mentions embed/embedding). */
const isEmbeddingModel = (id: string) => /embed/i.test(id);

interface EmbedAccelerator {
  id: string;
  kind: "cpu" | "gpu";
  backend: string;
  name: string;
  memoryBytes?: number;
}

const BACKEND_LABEL: Record<string, string> = { dml: "DirectML", cuda: "CUDA", coreml: "Core ML" };

function acceleratorLabel(a: EmbedAccelerator): string {
  if (a.kind === "cpu") return "CPU (recommended)";
  const vram = a.memoryBytes ? ` · ${Math.round(a.memoryBytes / 1024 ** 3)} GB` : "";
  return `${a.name}${vram}`;
}

/** Device picker for local embeddings. GPUs are listed by the host (DXGI / nvidia-smi / Core ML). */
function EmbedDeviceRow({ status, features }: { status: IndexStatus; features: FeatureConfig }) {
  const [accelerators, setAccelerators] = React.useState<EmbedAccelerator[] | null>(null);
  React.useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type === "embedAccelerators") setAccelerators(event.data.accelerators || []);
    };
    window.addEventListener("message", listener);
    vscode.postMessage({ type: "embedAcceleratorsGet" });
    return () => window.removeEventListener("message", listener);
  }, []);
  const selected = features.embedAccelerator || status.acceleratorId || "cpu";
  const list = accelerators ?? [{ id: "cpu", kind: "cpu", backend: "cpu", name: "CPU" }];
  // A saved GPU that is no longer present stays visible so the setting isn't silently lost.
  const options = list.some((a) => a.id === selected) ? list : [...list, { id: selected, kind: "gpu", backend: selected.split(":")[0], name: "Saved GPU (not detected)" } as EmbedAccelerator];
  const remote = status.backend === "remote";
  return (
    <Row
      title={tr("Run Embeddings On")}
      desc={remote
        ? "The selected embedding model runs on its provider; this applies to local models."
        : status.acceleratorError
        ? `The selected GPU could not be used, so embeddings run on the CPU: ${status.acceleratorError}`
        : "CPU keeps the GPU free and works everywhere. A dedicated GPU is usually much faster; integrated GPUs can be slower than the CPU."}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <Select
          aria-label={tr("Embedding device")}
          value={selected}
          disabled={remote || status.indexing || accelerators === null}
          onChange={(event) => vscode.postMessage({ type: "setEmbedAccelerator", id: event.target.value })}
          style={{ maxWidth: 300 }}
        >
          {options.map((a) => <option key={a.id} value={a.id} title={BACKEND_LABEL[a.backend]}>{acceleratorLabel(a)}</option>)}
        </Select>
        <button
          className="btn-ghost sm"
          title={tr("Detect GPUs again")}
          aria-label={tr("Detect GPUs again")}
          disabled={accelerators === null}
          onClick={() => { setAccelerators(null); vscode.postMessage({ type: "embedAcceleratorsGet", refresh: true }); }}
        >
          <Icon name="reset" />
        </button>
      </div>
    </Row>
  );
}

function IndexingPanel({
  status,
  models,
  modelList,
  docs,
  docsStatus,
  features,
  setFeatures,
}: {
  status: IndexStatus;
  models: EmbedModel[];
  modelList: ModelDef[];
  docs: DocSourceInfo[];
  docsStatus: DocsStatus;
  features: FeatureConfig;
  setFeatures: (p: Partial<FeatureConfig>) => void;
}) {
  const pct = status.total > 0 ? Math.round((status.done / status.total) * 100) : status.files > 0 ? 100 : 0;
  const remoteEmbed = modelList.filter((m) => isEmbeddingModel(m.id));
  const accel = status.accelerator || "pending";
  const accelClass =
    accel === "gpu" ? "gpu" : accel === "cpu" ? "cpu" : accel === "remote" ? "remote" : "pending";
  const accelText =
    accel === "gpu" ? "GPU" : accel === "cpu" ? "CPU" : accel === "remote" ? "Remote" : "Loading...";
  return (
    <>
      <h1 className="page-title">{tr("Indexing & Docs")}</h1>
      <div className="section-label">{tr("Codebase")}</div>
      <div className="index-card">
        <div className="index-card-title">{tr("Codebase Indexing")}</div>
        <p className="row-desc">
          {tr("Embed codebase for improved contextual understanding and knowledge. Embeddings and metadata are stored locally on your machine - your code never leaves your computer. The index persists across restarts; only new or changed files are re-embedded.")}
        </p>
        <div className="index-divider" />
        <Row title={tr("Enable Indexing")} desc={tr("When off, background embedding stops. Existing index files stay on disk; text search remains available.")}>
          <Toggle
            checked={features.indexingEnabled !== false}
            onChange={(v) => setFeatures({ indexingEnabled: v })}
          />
        </Row>
        <div className="index-progress" style={{ opacity: features.indexingEnabled === false ? 0.5 : 1 }}>
          <div className="index-progress-pct">{pct}%</div>
          <div className="index-bar">
            <div className="index-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="index-progress-meta">
            {features.indexingEnabled === false
              ? `Disabled - ${status.files} files on disk`
              : status.paused
              ? `Paused - ${status.files} files / ${status.chunks || 0} chunks indexed${status.total > status.done ? ` (${status.total - status.done} left in the last sync)` : ""}`
              : status.indexing
              ? `Indexing ${status.done} / ${status.total} files...`
              : `${status.files} files / ${status.chunks || 0} chunks`}
          </div>
          {status.limitReason && <div className="index-progress-meta" role="status">{status.limitReason}</div>}
        </div>
        <div className="index-divider" />
        <div className="index-runtime">
          <div className="index-runtime-head">
            <span className={`index-accel-badge ${accelClass}`}>{accelText}</span>
            <span className="index-runtime-device">{status.deviceLabel || "-"}</span>
          </div>
          <dl className="index-tech">
            <div>
              <dt>{tr("Model")}</dt>
              <dd>
                <code>{status.model}</code>
              </dd>
            </div>
            {status.modelRepo && (
              <div>
                <dt>{tr("Repo")}</dt>
                <dd>
                  <code>{status.modelRepo}</code>
                </dd>
              </div>
            )}
            {status.modelDtype && (
              <div>
                <dt>{tr("Dtype")}</dt>
                <dd>
                  <code>{status.modelDtype}</code>
                </dd>
              </div>
            )}
            {status.modelPooling && (
              <div>
                <dt>{tr("Pooling")}</dt>
                <dd>
                  <code>{status.modelPooling}</code>
                </dd>
              </div>
            )}
            {status.modelDim != null && (
              <div>
                <dt>{tr("Dimensions")}</dt>
                <dd>
                  <code>{status.modelDim}</code>
                </dd>
              </div>
            )}
            {status.device != null && status.device !== "" && (
              <div>
                <dt>{tr("ONNX EP")}</dt>
                <dd>
                  <code>{status.device}</code>
                </dd>
              </div>
            )}
            <div>
              <dt>{tr("Backend")}</dt>
              <dd>
                <code>{status.backend || "local"}</code>
              </dd>
            </div>
            {status.remoteBaseUrl && (
              <div>
                <dt>{tr("Endpoint")}</dt>
                <dd>
                  <code>{status.remoteBaseUrl}</code>
                </dd>
              </div>
            )}
            <div>
              <dt>{tr("Runtime")}</dt>
              <dd>
                <code>{status.runtime || "—"}</code>
              </dd>
            </div>
            <div>
              <dt>{tr("Platform")}</dt>
              <dd>
                <code>{status.platform || "—"}</code>
              </dd>
            </div>
          </dl>
        </div>
        <div className="index-divider" />
        <div className="index-model-row">
          <span className="index-model-label">{tr("Embedding model")}</span>
          <ModelSelect
            models={remoteEmbed}
            value={status.model}
            onChange={(id) => !status.indexing && features.indexingEnabled !== false && vscode.postMessage({ type: "setEmbedModel", modelId: id })}
            customItems={models.map((m) => ({ value: m.id, label: m.name, desc: "local - runs on your machine" }))}
            style={{ maxWidth: 260 }}
          />
          <div className="index-actions" style={{ marginTop: 0, marginLeft: "auto" }}>
            {status.paused ? (
              <button className="btn-secondary" disabled={features.indexingEnabled === false} onClick={() => vscode.postMessage({ type: "resumeIndex" })} title={tr("Continue indexing; files already embedded are skipped")}>
                <Icon name="play" /> {tr("Resume")}
              </button>
            ) : status.indexing ? (
              <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "pauseIndex" })} title={tr("Stop after the current batch and keep progress. Indexing stays enabled.")}>
                <Icon name="stop" /> {tr("Pause")}
              </button>
            ) : (
              <button className="btn-secondary" disabled={features.indexingEnabled === false} onClick={() => vscode.postMessage({ type: "syncIndex" })}>
                <Icon name="reset" /> {tr("Sync")}
              </button>
            )}
            <button className="btn-secondary danger" disabled={status.indexing} onClick={() => vscode.postMessage({ type: "deleteIndex" })}>
              <Icon name="trash" /> {tr("Delete Index")}
            </button>
          </div>
        </div>
      </div>
      <div className="index-card rows-card">
        <EmbedDeviceRow status={status} features={features} />
        <Row title={tr("Index New Folders")} desc={tr("Automatically index any new folders added to the workspace")}>
          <Toggle checked={features.indexNewFolders !== false} onChange={(v) => setFeatures({ indexNewFolders: v })} disabled={features.indexingEnabled === false} />
        </Row>
        <Row title={tr("Ignore Files in .cursorignore")} desc={tr("Files to exclude from indexing in addition to .gitignore")}>
          <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "aiWorkHarnessignore" })}>{tr("Edit")}</button>
        </Row>
        <Row title={tr("Index Repositories for Instant Grep")} desc={tr("Automatically index repositories to speed up Grep searches. All data is stored locally.")}>
          <Toggle checked={features.indexForGrep !== false} onChange={(v) => setFeatures({ indexForGrep: v })} disabled={features.indexingEnabled === false} />
        </Row>
      </div>
      <DocsSection docs={docs} status={docsStatus} />
    </>
  );
}

function KnowledgePanel({
  features,
  setFeatures,
  taskModelChoices,
  codeGraphStatus,
}: {
  features: FeatureConfig;
  setFeatures: (p: Partial<FeatureConfig>) => void;
  taskModelChoices: ModelDef[];
  codeGraphStatus?: CodeGraphStatus;
}) {
  const graph = codeGraphStatus;
  const stamp = (value?: string | number) => (value ? new Date(value).toLocaleString(getLocale()) : "");
  const built = graph?.available ? stamp(graph.generatedAt) : "";
  const graphDesc = !graph
    ? tr("Loading…")
    : !graph.available
      ? tr("No graph built yet. Enable Auto-build, or build it from the Project Docs panel.")
      : `${graph.nodes} ${tr("nodes")} · ${graph.edges} ${tr("edges")}${built ? ` · ${built}` : ""}${graph.stale ? ` · ${tr("stale, HEAD has moved")}` : ""}`;
  const injectDesc = !graph || !graph.injections
    ? tr("No agent turn has consumed the graph yet.")
    : `${graph.injections} ${tr("turns")} · ${Math.round(graph.injectedChars / 1000)}k ${tr("characters injected")}${graph.lastUsedAt ? ` · ${stamp(graph.lastUsedAt)}` : ""}`;
  return (
    <>
      <h1 className="page-title">{tr("Repo Wiki")}</h1>
      <div className="section-label">{tr("Code Graph")}</div>
      <Group>
        <Row title={tr("Auto-build")} desc={tr("Scan the repository with graphify and refresh .docs/graphify-out when the cached graph is missing or out of date. Builds run in the background.")}>
          <Toggle checked={features.codeGraphEnabled === true} onChange={(v) => setFeatures({ codeGraphEnabled: v })} />
        </Row>
        <Row title={tr("Let the agent use it")} desc={tr("Inject the cached graph into the chat context and enable the CodeGraph tool. Turn this off to save context without deleting the graph.")}>
          <Toggle checked={features.codeGraphConsume !== false} onChange={(v) => setFeatures({ codeGraphConsume: v })} />
        </Row>
      </Group>
      <div className="section-label">{tr("Status")}</div>
      <Group>
        <Row title={tr("Cached graph")} desc={graphDesc}>
          <span className="row-desc">{graph?.available ? tr("ready") : tr("empty")}</span>
        </Row>
        <Row title={tr("Builds")} desc={graph
          ? `${graph.builds} ${tr("succeeded")} · ${graph.buildFailures} ${tr("failed")}${graph.lastBuildAt ? ` · ${stamp(graph.lastBuildAt)}` : ""}`
          : tr("Loading…")}>
          <span />
        </Row>
        <Row title={tr("Context injections")} desc={injectDesc}>
          <span />
        </Row>
        <Row title={tr("CodeGraph tool calls")} desc={tr("Queries answered from the graph instead of re-reading files.")}>
          <span className="row-desc">{graph?.toolCalls ?? 0}</span>
        </Row>
      </Group>
      <div className="section-label">{tr("Task Models")}</div>
      <Group>
        <Row title={tr("Catalog Generation")} desc={tr("Model used to plan the Project Docs catalog and its page tree. Empty uses the chat model.")}>
          <ModelSelect
            models={taskModelChoices}
            value={features.docsCatalogModel || ""}
            onChange={(id) => setFeatures({ docsCatalogModel: id })}
            customItems={[{ value: "", label: tr("Chat model"), desc: tr("use the default chat model") }]}
            style={{ maxWidth: 240 }}
          />
        </Row>
        <Row title={tr("Content Generation")} desc={tr("Model used to research and write each Project Docs page. Empty uses the chat model.")}>
          <ModelSelect
            models={taskModelChoices}
            value={features.docsContentModel || ""}
            onChange={(id) => setFeatures({ docsContentModel: id })}
            customItems={[{ value: "", label: tr("Chat model"), desc: tr("use the default chat model") }]}
            style={{ maxWidth: 240 }}
          />
        </Row>
        <Row title={tr("Translation")} desc={tr("Model used for translation tasks in generated documentation. Empty follows the content model.")}>
          <ModelSelect
            models={taskModelChoices}
            value={features.docsTranslationModel || ""}
            onChange={(id) => setFeatures({ docsTranslationModel: id })}
            customItems={[{ value: "", label: tr("Content model"), desc: tr("follow the content generation model") }]}
            style={{ maxWidth: 240 }}
          />
        </Row>
        <Row title={tr("Graphify")} desc={tr("Model passed to the external graphify CLI for semantic extraction and community labels. Empty uses the chat model.")}>
          <ModelSelect
            models={taskModelChoices}
            value={features.docsGraphifyModel || ""}
            onChange={(id) => setFeatures({ docsGraphifyModel: id })}
            customItems={[{ value: "", label: tr("Chat model"), desc: tr("use the default chat model") }]}
            style={{ maxWidth: 240 }}
          />
        </Row>
      </Group>

      <div className="section-label">{tr("Project Docs Limits")}</div>
      <Group>
        <Row title={tr("Max documentation pages")} desc={tr("Upper bound for generated pages. 0 uses the default (90).")}>
          <NumInput value={features.docsMaxPages || null} min="0" placeholder="90" onChange={(v) => setFeatures({ docsMaxPages: v ?? 0 })} />
        </Row>
        <Row title={tr("Max catalog files")} desc={tr("Files listed to the planner. 0 uses the default (4000).")}>
          <NumInput value={features.docsMaxCatalogFiles || null} min="0" placeholder="4000" onChange={(v) => setFeatures({ docsMaxCatalogFiles: v ?? 0 })} />
        </Row>
        <Row title={tr("Max catalog characters")} desc={tr("Character budget for the repository listing. 0 uses the default (80000).")}>
          <NumInput value={features.docsMaxCatalogChars || null} min="0" placeholder="80000" onChange={(v) => setFeatures({ docsMaxCatalogChars: v ?? 0 })} />
        </Row>
        <Row title={tr("Max source file size (KB)")} desc={tr("Files larger than this are skipped while scanning. 0 uses the default (1024).")}>
          <NumInput value={features.docsMaxFileKb || null} min="0" placeholder="1024" onChange={(v) => setFeatures({ docsMaxFileKb: v ?? 0 })} />
        </Row>
        <Row title={tr("Catalog planning steps")} desc={tr("Tool steps available while planning the catalog. 0 uses the default (50).")}>
          <NumInput value={features.docsCatalogSteps || null} min="0" placeholder="50" onChange={(v) => setFeatures({ docsCatalogSteps: v ?? 0 })} />
        </Row>
        <Row title={tr("Mind map steps")} desc={tr("Tool steps available while building the mind map. 0 uses the default (40).")}>
          <NumInput value={features.docsMindmapSteps || null} min="0" placeholder="40" onChange={(v) => setFeatures({ docsMindmapSteps: v ?? 0 })} />
        </Row>
        <Row title={tr("Mind map output tokens")} desc={tr("Maximum output tokens for the mind map. 0 uses the default (8192).")}>
          <NumInput value={features.docsMindmapTokens || null} min="0" placeholder="8192" onChange={(v) => setFeatures({ docsMindmapTokens: v ?? 0 })} />
        </Row>
      </Group>
    </>
  );
}

function EngineStatusRow({
  engine,
  installing,
  uninstalling,
  log,
  result,
}: {
  engine: EngineStatusInfo;
  installing: boolean;
  uninstalling?: boolean;
  log?: string[];
  result?: EngineInstallResult;
}) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    if (!engine.installCommand) return;
    try {
      await navigator.clipboard.writeText(engine.installCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — keep the command text selectable */
    }
  };
  return (
    <div className="row">
      <div className="row-text">
        <div className="row-title">
          {engine.label}{" "}
          {uninstalling ? (
            <span className="badge-tag loading"><span className="llama-spinner" /> {tr("Removing…")}</span>
          ) : installing ? (
            <span className="badge-tag loading"><span className="llama-spinner" /> {tr("Installing…")}</span>
          ) : engine.available ? (
            <span className="badge-tag engine-status-badge ok">{tr("Installed")}</span>
          ) : engine.manual ? (
            <span className="badge-tag engine-status-badge missing">{tr("Manual install required")}</span>
          ) : (
            <span className="badge-tag engine-status-badge missing">{tr("Not installed")}</span>
          )}
        </div>
        {engine.binaryPath && <div className="row-desc engine-status-path" title={engine.binaryPath}>{engine.binaryPath}</div>}
        {engine.source && (
          <div className="row-desc engine-status-path">{tr(ENGINE_SOURCE_LABELS[engine.source] || engine.source)}</div>
        )}
        {engine.installCommand && (
          <div className="engine-status-command">
            <code title={engine.installCommand}>{engine.installCommand}</code>
            <button className="btn-secondary" onClick={copy} disabled={installing || uninstalling}>{copied ? tr("Copied") : tr("Copy command")}</button>
          </div>
        )}
        {result?.detail && <div className={"row-desc" + (result.ok ? "" : " engine-status-error")}>{tr(result.detail)}</div>}
        {(installing || uninstalling) && log && log.length > 0 && (
          <div className="engine-status-log">
            <div className="row-desc">{uninstalling ? tr("Uninstall log") : tr("Installation log")}</div>
            <pre className="llama-log-pre">{log.join("\n")}</pre>
          </div>
        )}
      </div>
      <div className="row-control">
        <button className="btn-secondary" disabled={installing || uninstalling} onClick={() => vscode.postMessage({ type: "pickEnginePath", id: engine.id })}>{tr("Select installed path")}</button>
        {engine.source === "override" && (
          <button className="btn-secondary" disabled={installing || uninstalling} onClick={() => vscode.postMessage({ type: "clearEnginePath", id: engine.id })}>{tr("Clear path")}</button>
        )}
        {engine.removable && !installing && !uninstalling && (
          <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "uninstallEngine", id: engine.id })}>{tr("Uninstall")}</button>
        )}
        {installing ? (
          <button className="btn-secondary" disabled>{tr("Install")}</button>
        ) : !engine.available && engine.installCommand ? (
          <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "installEngine", id: engine.id })}>{tr("Install")}</button>
        ) : !engine.available && engine.manual && engine.docsUrl ? (
          <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "openExternal", url: engine.docsUrl })}>{tr("Open docs")}</button>
        ) : null}
      </div>
    </div>
  );
}

export function App() {
  const [section, setSection] = React.useState<Section>("general");
  const contentRef = React.useRef<HTMLElement>(null);
  const [s, setS] = React.useState<Settings>(DEFAULTS);
  const [apiKey, setApiKey] = React.useState("");
  const [models, setModels] = React.useState<string[]>([]);
  const [modelList, setModelList] = React.useState<ModelDef[]>([]);
  const [features, setFeaturesState] = React.useState<FeatureConfig>(EMPTY_FEATURES);
  const [mcpStatus, setMcpStatus] = React.useState<McpStatus[]>([]);
  const [rules, setRules] = React.useState<RuleInfo[]>([]);
  const [skills, setSkills] = React.useState<SkillInfo[]>([]);
  const [builtinPersonas, setBuiltinPersonas] = React.useState<Persona[]>([]);
  const [modelCatalog, setModelCatalog] = React.useState<ModelDef[]>([]);
  const [indexStatus, setIndexStatus] = React.useState<IndexStatus>({ indexing: false, done: 0, total: 0, files: 0, chunks: 0, model: "minilm" });
  const [embedModels, setEmbedModels] = React.useState<EmbedModel[]>([]);
  const [docSources, setDocSources] = React.useState<DocSourceInfo[]>([]);
  const [docsStatus, setDocsStatus] = React.useState<DocsStatus>({ done: 0, total: 0 });
  const [llamacppStatus, setLlamacppStatus] = React.useState<LlamacppStatus>({ installed: false, running: {}, loading: {}, errors: {}, logs: {} });
  const [ollamaStatus, setOllamaStatus] = React.useState<OllamaStatus>({ installed: false, pulling: {}, errors: {} });
  const [ollamaModels, setOllamaModels] = React.useState<OllamaModel[]>([]);
  const [oauthStatus, setOauthStatus] = React.useState<OAuthStatus>({ accounts: [], errors: {} });
  const [usage, setUsage] = React.useState<Record<string, ModelUsage>>({});
  const [codeGraphStatus, setCodeGraphStatus] = React.useState<CodeGraphStatus | undefined>();
  const [engineStatus, setEngineStatus] = React.useState<EngineStatusInfo[]>([]);
  const [engineInstalling, setEngineInstalling] = React.useState<string | null>(null);
  const [engineUninstalling, setEngineUninstalling] = React.useState<string | null>(null);
  const [engineLogs, setEngineLogs] = React.useState<Record<string, string[]>>({});
  const [engineUninstallLogs, setEngineUninstallLogs] = React.useState<Record<string, string[]>>({});
  const [engineResults, setEngineResults] = React.useState<Record<string, EngineInstallResult>>({});
  const taskModelChoices = modelList.length
    ? modelList
    : [...modelCatalog, ...(features.customModels || [])].filter((m) => features.enabledModels.includes(m.id));
  const [navQuery, setNavQuery] = React.useState("");

  React.useEffect(() => { setMotionPreference(features.motion); }, [features.motion]);

  React.useLayoutEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
      contentRef.current.scrollLeft = 0;
    }
  }, [section]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((prev) => ({ ...prev, [k]: v }));

  // Patch + persist features immediately.
  const setFeatures = (patch: Partial<FeatureConfig>) => {
    setFeaturesState((prev) => ({ ...prev, ...patch }));
    // Other views can update model options while this settings page stays open.
    vscode.postMessage({ type: "saveFeatures", features: patch });
  };

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "loadSettings") {
        setS({ ...DEFAULTS, ...msg.settings });
      } else if (msg.type === "navigate") {
        if (msg.section) setSection(msg.section as Section);
      } else if (msg.type === "modelsFetched") {
        setModels(msg.models || []);
        if (msg.modelList) setModelList(msg.modelList);
      } else if (msg.type === "features") {
        setLocale(msg.language);
        setFeaturesState({ ...EMPTY_FEATURES, ...msg.features });
        setMcpStatus(msg.mcpStatus || []);
        setRules(msg.rules || []);
        setSkills(msg.skills || []);
        setBuiltinPersonas(msg.builtinPersonas || []);
        setModelCatalog(msg.modelCatalog || []);
      } else if (msg.type === "indexStatus") {
        setIndexStatus(msg.status);
        if (msg.models) setEmbedModels(msg.models);
      } else if (msg.type === "docSources") {
        setDocSources(msg.docs || []);
        if (msg.status) setDocsStatus(msg.status);
      } else if (msg.type === "docsStatus") {
        setDocsStatus(msg.status);
        // Refresh doc list when an indexing run finishes.
        if (!msg.status?.indexing) vscode.postMessage({ type: "getIndexStatus" });
      } else if (msg.type === "llamacppStatus") {
        setLlamacppStatus(msg.status);
      } else if (msg.type === "ollamaStatus") {
        setOllamaStatus(msg.status);
      } else if (msg.type === "ollamaModels") {
        setOllamaModels(msg.models || []);
      } else if (msg.type === "oauthStatus") {
        setOauthStatus(msg.status);
      } else if (msg.type === "usageData") {
        setUsage(msg.usage || {});
      } else if (msg.type === "codeGraphStatus") {
        setCodeGraphStatus(msg.status || undefined);
      } else if (msg.type === "engineStatus") {
        setEngineStatus(msg.engines || []);
      } else if (msg.type === "engineInstallStarted") {
        setEngineInstalling(msg.id);
        setEngineLogs((prev) => ({ ...prev, [msg.id]: [] }));
        setEngineResults((prev) => {
          const next = { ...prev };
          delete next[msg.id];
          return next;
        });
      } else if (msg.type === "engineInstallProgress") {
        setEngineLogs((prev) => ({
          ...prev,
          [msg.id]: [...(prev[msg.id] || []), String(msg.line ?? "")].slice(-200),
        }));
      } else if (msg.type === "engineInstallDone") {
        setEngineInstalling(null);
        setEngineResults((prev) => ({ ...prev, [msg.id]: { ok: !!msg.ok, detail: msg.detail } }));
      } else if (msg.type === "engineUninstallStarted") {
        setEngineUninstalling(msg.id);
        setEngineUninstallLogs((prev) => ({ ...prev, [msg.id]: [] }));
        setEngineResults((prev) => {
          const next = { ...prev };
          delete next[msg.id];
          return next;
        });
      } else if (msg.type === "engineUninstallProgress") {
        setEngineUninstallLogs((prev) => ({
          ...prev,
          [msg.id]: [...(prev[msg.id] || []), String(msg.line ?? "")].slice(-200),
        }));
      } else if (msg.type === "engineUninstallDone") {
        setEngineUninstalling(null);
        setEngineResults((prev) => ({ ...prev, [msg.id]: { ok: !!msg.ok, detail: msg.detail } }));
      } else if (msg.type === "enginePathPicked") {
        // A successful pick is followed by a fresh engineStatus; cancels need no UI change.
      }
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "getSettings" });
    vscode.postMessage({ type: "getFeatures" });
    vscode.postMessage({ type: "getIndexStatus" });
    vscode.postMessage({ type: "getUsage" });
    vscode.postMessage({ type: "oauthGet" });
    return () => window.removeEventListener("message", handler);
  }, []);

  // Refresh usage numbers whenever the Usage & Quota page is opened.
  React.useEffect(() => {
    if (section === "usage") vscode.postMessage({ type: "getUsage" });
  }, [section]);

  // Refresh the code-graph readout whenever the Knowledge page is opened.
  React.useEffect(() => {
    if (section === "knowledge") vscode.postMessage({ type: "getCodeGraphStatus" });
  }, [section]);

  // Probe external engine installs whenever the Agents page is opened.
  React.useEffect(() => {
    if (section === "agents") vscode.postMessage({ type: "getEngineStatus" });
  }, [section]);

  // Fetch models across every enabled provider (grouped). Disabled providers are skipped.
  const fetchModels = () => vscode.postMessage({ type: "fetchAllModels" });

  const save = () => {
    const payload: any = { type: "saveSettings", settings: s };
    if (apiKey) payload.apiKey = apiKey;
    vscode.postMessage(payload);
  };

  const navFiltered = navQuery.trim()
    ? NAV.filter((n) => {
        const q = navQuery.trim().toLowerCase();
        return tr(n.label).toLowerCase().includes(q) || n.label.toLowerCase().includes(q) || (SECTION_KEYWORDS[n.id] || "").includes(q);
      })
    : NAV;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-badge" src={document.getElementById("root")?.dataset.icon} alt="" />
          <span>
            <span className="brand-name">{tr("Settings")}</span>
            <span className="brand-sub">{tr("Ai Work Harness")}</span>
          </span>
        </div>
        <input
          className="nav-search"
          type="search"
          placeholder={tr("Search settings")}
          aria-label={tr("Search settings")}
          value={navQuery}
          onChange={(e) => setNavQuery(e.target.value)}
        />
        {navFiltered.map((n) => (
          <React.Fragment key={n.id}>
            {n.sep && !navQuery && <div className="nav-sep" />}
            <button className={"nav-item" + (section === n.id ? " active" : "")} aria-current={section === n.id ? "page" : undefined} onClick={() => setSection(n.id)}>
              <Icon name={n.icon} />
              <span>{tr(n.label)}</span>
            </button>
            {n.id === "general" && !navQuery && (
              <button className="nav-item" onClick={() => vscode.postMessage({ type: "openVsCodeSettings" })}>
                <Icon name="code" />
                <span>{tr("VS Code Settings ↗")}</span>
              </button>
            )}
          </React.Fragment>
        ))}
      </aside>

      <main className="content" ref={contentRef}>
        <div className="settings-page">
        <div className="content-inner" key={section}>
          {section === "general" && (
            <>
              <h1 className="page-title">{tr("General")}</h1>

              <Group>
                <Row title={tr("Providers & API Keys")} desc={tr("Manage the AI providers, API keys and OAuth accounts this extension talks to.")}>
                  <button className="btn-secondary" onClick={() => setSection("providers")}>{tr("Open")}</button>
                </Row>
              </Group>

              <div className="section-label">{tr("Preferences")}</div>
              <Group>
                <Row title={tr("Language")} desc={tr("Choose the language used by the chat and settings interface. Auto follows VS Code's display language.")}>
                  <Select aria-label={tr("Language")} value={features.language ?? "auto"} onChange={(event) => setFeatures({ language: event.target.value as LanguagePreference })}>
                    {LANGUAGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{tr(option.label)}</option>
                    ))}
                  </Select>
                </Row>
                <Row title={tr("Animations")} desc={tr("Enable animated loading indicators and transitions, follow your system preference, or reduce motion.")}>
                  <Select aria-label={tr("Animations")} value={features.motion} onChange={(event) => setFeatures({ motion: event.target.value as MotionPreference })}>
                    <option value="full">{tr("Enabled")}</option>
                    <option value="system">{tr("Follow system")}</option>
                    <option value="reduced">{tr("Reduced motion")}</option>
                  </Select>
                </Row>
                <Row title={tr("Editor Settings")} desc={tr("Configure font, formatting, minimap and more.")}>
                  <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "openEditorSettings" })}>{tr("Open ↗")}</button>
                </Row>
                <Row title={tr("Keyboard Shortcuts")} desc={tr("Configure keyboard shortcuts.")}>
                  <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "openKeyboardShortcuts" })}>{tr("Open ↗")}</button>
                </Row>
                <Row title={tr("VS Code Settings")} desc={tr("Open the native VS Code settings UI.")}>
                  <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "openVsCodeSettings" })}>{tr("Open ↗")}</button>
                </Row>
              </Group>

              <div className="section-label">{tr("Chat")}</div>
              <Group>
                <Row title={tr("Auto-Generate Chat Titles")} desc={tr("Generate a short AI title for new conversations after the first message.")}>
                  <Toggle checked={features.autoGenerateTitles !== false} onChange={(v) => setFeatures({ autoGenerateTitles: v })} />
                </Row>
                <Row title={tr("Per-Tab Composer Drafts")} desc={tr("Keep a separate unsent message per chat tab. When off, the composer text follows you between tabs.")}>
                  <Toggle checked={features.perTabDrafts === true} onChange={(v) => setFeatures({ perTabDrafts: v })} />
                </Row>
                {/* Auto model (judge routing) hidden for now — bring back later.
                <Row title="Auto Judge Model" desc="When the chat model is set to Auto, this judge model picks the best enabled model for each task.">
                  <ModelSelect
                    models={modelList.length ? modelList : [...modelCatalog, ...(features.customModels || [])].filter((m) => features.enabledModels.includes(m.id))}
                    value={features.autoJudgeModel}
                    onChange={(id) => setFeatures({ autoJudgeModel: id })}
                    customItems={[{ value: "", label: "First enabled model", desc: "use the first model in the picker" }]}
                    style={{ maxWidth: 240 }}
                  />
                </Row>
                */}
              </Group>

              <div className="section-label">{tr("Notifications")}</div>
              <Group>
                <Row title={tr("System Notifications")} desc={tr("Show a notification when the agent finishes responding while the window is unfocused.")}>
                  <Toggle checked={features.notifyOnComplete !== false} onChange={(v) => setFeatures({ notifyOnComplete: v })} />
                </Row>
                <Row title={tr("Completion Sound")} desc={tr("Play a sound when the agent finishes responding.")}>
                  <Toggle checked={features.completionSound === true} onChange={(v) => setFeatures({ completionSound: v })} />
                </Row>
              </Group>

              <div className="section-label">{tr("Privacy")}</div>
              <p className="panel-hint">
                {tr("AiWorkHarness is fully local and open source. There is no AiWorkHarness backend - your code, keys and conversations stay on your machine and are only ever sent to the AI providers you configure yourself.")}
              </p>
              <Group>
                <Row title={tr("Local-First")} desc={tr("Conversations, settings and workspace context are stored on this device (VS Code global storage).")}>
                  <span className="badge-tag always">{tr("Always on")}</span>
                </Row>
                <Row title={tr("Secure Key Storage")} desc={tr("API keys and OAuth tokens are kept in the OS secret store (VS Code SecretStorage), never in plain-text settings or synced files.")}>
                  <span className="badge-tag always">{tr("Encrypted")}</span>
                </Row>
                <Row title={tr("No Telemetry")} desc={tr("AiWorkHarness collects no analytics, usage metrics or crash reports. The only outbound requests are the AI calls you trigger to your configured providers.")}>
                  <span className="badge-tag always">{tr("None")}</span>
                </Row>
                <Row title={tr("You Choose the Destination")} desc={tr("Every request goes to the exact provider you set up — a hosted API, your own OpenAI/Anthropic-compatible endpoint, or a fully offline model via llama.cpp / Ollama.")}>
                  <span className="badge-tag">{tr("Your providers")}</span>
                </Row>
                <Row title={tr("Open Source")} desc={tr("The full source is public and MIT-licensed, so anyone can audit exactly what the extension does with your data.")}>
                  <span className="badge-tag glob">{tr("MIT")}</span>
                </Row>
              </Group>
            </>
          )}

          {section === "agents" && (
            <>
              <h1 className="page-title">{tr("Agents")}</h1>

              <Group>
                <Row title={tr("Agent engine")} desc={tr("Choose which engine drives agent turns. External engines run their own CLI; AiWorkHarness handles chat, approvals and the UI.")}>
                  <Select
                    aria-label={tr("Agent engine")}
                    value={features.agentEngine ?? "builtin"}
                    onChange={(e) => setFeatures({ agentEngine: e.target.value as FeatureConfig["agentEngine"] })}
                  >
                    <option value="builtin">{tr("Built-in (recommended)")}</option>
                    <option value="claude-code">{tr("Claude Code")}</option>
                    <option value="opencode">{tr("OpenCode")}</option>
                    <option value="dsh">{tr("DeepSeek Harness (experimental)")}</option>
                    <option value="gemini">{tr("Gemini CLI")}</option>
                    <option value="qwen">{tr("Qwen Code")}</option>
                    <option value="kimi">{tr("Kimi CLI")}</option>
                    <option value="crush">{tr("Crush")}</option>
                    <option value="zcode">{tr("ZCode")}</option>
                    <option value="pi">pi</option>
                    <option value="codex">{tr("Codex")}</option>
                  </Select>
                </Row>
                <Row title={tr("Use AiWorkHarness models for external engines")} desc={tr("Route the engine's model calls through a local bridge. It listens only on 127.0.0.1 with a random port and token, so only this machine can reach it.")}>
                  <Toggle checked={features.engineBridgeEnabled === true} onChange={(v) => setFeatures({ engineBridgeEnabled: v })} />
                </Row>
                {features.engineBridgeEnabled === true && (
                  <Row title={tr("Bridged model")} desc={tr("Force one AiWorkHarness model; leave empty to honor the model requested by the engine.")}>
                    <Select
                      aria-label={tr("Bridged model")}
                      value={features.engineBridgeModel || ""}
                      onChange={(e) => setFeatures({ engineBridgeModel: e.target.value })}
                    >
                      <option value="">{tr("Engine's requested model")}</option>
                      {modelList.map((m) => (
                        <option key={m.id} value={m.id}>{m.name || m.id}</option>
                      ))}
                    </Select>
                  </Row>
                )}
                <Row title={tr("Text Size")} desc={tr("Adjust the conversation text size.")}>
                  <Select
                    aria-label={tr("Text size")}
                    value={features.chatTextSize || "default"}
                    onChange={(e) => setFeatures({ chatTextSize: e.target.value as FeatureConfig["chatTextSize"] })}
                  >
                    <option value="compact">{tr("Compact")}</option>
                    <option value="default">{tr("Default")}</option>
                    <option value="large">{tr("Large")}</option>
                  </Select>
                </Row>
                <Row title={tr("Submit with Ctrl + Enter")} desc={tr("When enabled, Ctrl + Enter submits chat and Enter inserts a newline.")}>
                  <Toggle checked={features.submitWithCtrlEnter === true} onChange={(v) => setFeatures({ submitWithCtrlEnter: v })} />
                </Row>
                <Row title={tr("Max Tab Count")} desc={tr("Limit how many chat tabs can be open at once (0 = unlimited).")}>
                  <NumInput value={features.maxTabCount || null} step="1" min="0" placeholder="unlimited" onChange={(v) => setFeatures({ maxTabCount: v ?? 0 })} />
                </Row>
              </Group>

              <div className="docs-head">
                <div className="section-label">{tr("Engine status")}</div>
                <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "getEngineStatus" })}>
                  <Icon name="reset" /> {tr("Recheck")}
                </button>
              </div>
              {engineStatus.length > 0 && (
                <>
                  <p className="panel-hint">
                    {engineStatus[0]?.installScope === "global"
                      ? tr("Installs into the global npm environment.")
                      : tr("Installs into the extension folder — your global npm environment stays untouched.")}
                  </p>
                  <Group>
                    {engineStatus.map((engine) => (
                      <EngineStatusRow
                        key={engine.id}
                        engine={engine}
                        installing={engineInstalling === engine.id}
                        uninstalling={engineUninstalling === engine.id}
                        log={engineUninstalling === engine.id ? engineUninstallLogs[engine.id] : engineLogs[engine.id]}
                        result={engineResults[engine.id]}
                      />
                    ))}
                  </Group>
                </>
              )}

              <div className="section-label">{tr("Run Limits")}</div>
              <Group>
                <Row title={tr("Max Agent Steps")} desc={tr("Pause the agent after this many steps in a single run (0 = default 50).")}>
                  <NumInput value={features.maxAgentSteps || null} step="1" min="0" placeholder="50" onChange={(v) => setFeatures({ maxAgentSteps: v ?? 0 })} />
                </Row>
                <Row title={tr("Auto Continue")} desc={tr("Automatically continue when the step limit is reached instead of pausing.")}>
                  <Toggle checked={features.autoContinue === true} onChange={(v) => setFeatures({ autoContinue: v })} />
                </Row>
              </Group>

              <div className="section-label">{tr("Tool Timeouts")}</div>
              <p className="panel-hint">{tr("Hard timeout per tool (seconds). Empty = built-in default. Prevents a hung tool from blocking the agent forever.")}</p>
              <Group>
                {TOOL_TIMEOUT_DEFAULTS.map(({ name, sec }) => {
                  const overrides = features.toolTimeoutsSec || {};
                  const val = overrides[name];
                  return (
                    <Row key={name} title={name} desc={`Default ${sec}s`}>
                      <NumInput
                        value={val != null && val > 0 ? val : null}
                        step="1"
                        min="1"
                        placeholder={String(sec)}
                        onChange={(v) => {
                          const next = { ...(features.toolTimeoutsSec || {}) };
                          if (v == null || v <= 0) delete next[name];
                          else next[name] = Math.floor(v);
                          setFeatures({ toolTimeoutsSec: next });
                        }}
                      />
                    </Row>
                  );
                })}
              </Group>

              <div className="section-label">{tr("Subagents")}</div>
              <p className="panel-hint">
                {tr("Subagents, teams and the default subagent model live in the")} <button className="link-btn" onClick={() => setSection("subagents")}>{tr("Subagents & Teams")}</button> {tr("tab.")}
              </p>

              <div className="section-label">{tr("Context")}</div>
              <Group>
                <Row title={tr("Web Search Tool")} desc={tr("Allow the agent to search the web for relevant information.")}>
                  <Toggle checked={features.webSearchEnabled !== false} onChange={(v) => setFeatures({ webSearchEnabled: v })} />
                </Row>
                <Row title={tr("Web Fetch Tool")} desc={tr("Allow the agent to fetch content from URLs.")}>
                  <Toggle checked={features.webFetchEnabled !== false} onChange={(v) => setFeatures({ webFetchEnabled: v })} />
                </Row>
              </Group>

              <div className="section-label">{tr("Approvals & Execution")}</div>
              <p className="panel-hint">
                {tr("Tool capabilities and approval gates live in the")} <button className="link-btn" onClick={() => setSection("behavior")}>{tr("Behavior")}</button> {tr("tab.")}
              </p>
            </>
          )}

          {section === "usage" && (
            <UsagePanel usage={usage} oauthStatus={oauthStatus} features={features} setFeatures={setFeatures} />
          )}

          {section === "providers" && <ProvidersPanel features={features} setFeatures={setFeatures} oauthStatus={oauthStatus} />}

          {section === "models" && (
            <ModelsPanel
              models={models}
              modelList={modelList}
              features={features}
              setFeatures={setFeatures}
              fetchModels={fetchModels}
              catalog={modelCatalog}
              llamacppStatus={llamacppStatus}
              ollamaModels={ollamaModels}
              oauthStatus={oauthStatus}
            />
          )}

          {section === "llamacpp" && <LlamacppPanel features={features} status={llamacppStatus} />}

          {section === "ollama" && <OllamaPanel status={ollamaStatus} models={ollamaModels} />}

          {section === "personas" && <PersonasPanel features={features} setFeatures={setFeatures} builtinPersonas={builtinPersonas} />}

          {section === "memory" && <MemoryPanel features={features} setFeatures={setFeatures} />}

          {section === "rules" && <RulesPanel rules={rules} skills={skills} />}

          {section === "skillMarket" && <SkillMarketPanel />}

          {section === "subagents" && <SubagentsPanel features={features} setFeatures={setFeatures} models={models} modelList={modelList} />}

          {section === "mcp" && (
            <McpPanel
              features={features}
              setFeatures={setFeatures}
              status={mcpStatus}
              onSync={() => vscode.postMessage({ type: "syncMcp" })}
            />
          )}

          {section === "hooks" && <HooksPanel features={features} setFeatures={setFeatures} />}

          {section === "behavior" && (
            <>
              <h1 className="page-title">{tr("Behavior")}</h1>
              <div className="section-label">{tr("Capabilities")}</div>
              <Group>
                <Row title={tr("Workspace Context")} desc={tr("Include workspace info in the agent's context.")}>
                  <Toggle checked={s.enableWorkspaceContext} onChange={(v) => set("enableWorkspaceContext", v)} />
                </Row>
                <Row title={tr("File Reading Tools")} desc={tr("Allow reading, searching and listing files.")}>
                  <Toggle checked={s.enableFileReading} onChange={(v) => set("enableFileReading", v)} />
                </Row>
                <Row title={tr("Terminal Tools")} desc={tr("Allow running terminal commands.")}>
                  <Toggle checked={s.enableTerminalSuggestions} onChange={(v) => set("enableTerminalSuggestions", v)} />
                </Row>
              </Group>

              <div className="section-label">{tr("Approvals & Execution")}</div>
              <p className="panel-hint">
                {tr("Per-action approval policy.")} <strong>{tr("Allow")}</strong> {tr("runs silently,")} <strong>{tr("Auto Review")}</strong> {tr("only asks for risky-looking actions (destructive commands, secrets, deletes),")} <strong>{tr("Ask")}</strong> {tr("prompts every time,")} <strong>{tr("Deny")}</strong> {tr("always blocks. Allow/deny lists override the mode per command or file pattern.")}
              </p>
              {APPROVAL_ACTIONS.map((a) => (
                <ApprovalCard
                  key={a.type}
                  action={a}
                  policy={{ ...DEFAULT_APPROVAL, ...(features.approvalPolicy ?? {}) }}
                  onChange={(p) => setFeatures({ approvalPolicy: p })}
                />
              ))}
              <div className="panel-actions">
                <button
                  className="btn-ghost sm"
                  onClick={() => setFeatures({ approvalPolicy: DEFAULT_APPROVAL })}
                >
                  <Icon name="reset" size={13} /> {tr("Reset policy to defaults")}
                </button>
              </div>
            </>
          )}

          {section === "indexing" && (
            <IndexingPanel status={indexStatus} models={embedModels} modelList={modelList} docs={docSources} docsStatus={docsStatus} features={features} setFeatures={setFeatures} />
          )}

          {section === "knowledge" && (
            <KnowledgePanel features={features} setFeatures={setFeatures} taskModelChoices={taskModelChoices} codeGraphStatus={codeGraphStatus} />
          )}

          {section === "advanced" && (
            <>
              <h1 className="page-title">{tr("Advanced")}</h1>
              <div className="section-label">{tr("Custom Instructions")}</div>
              <Row title={tr("System Prompt")} desc={tr("Prepended to the agent's system prompt for every request.")} stacked>
                <textarea rows={6} value={s.systemPrompt} onChange={(e) => set("systemPrompt", e.target.value)} />
              </Row>
            </>
          )}

          {section === "about" && (
            <>
              <h1 className="page-title">{tr("About")}</h1>
              <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "6px 0 18px" }}>
                <img src={document.getElementById("root")?.dataset.icon} alt="" style={{ width: 48, height: 48, borderRadius: 10 }} />
                <div>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>{tr("Ai Work Harness")}</div>
                  <div className="row-desc" style={{ margin: 0 }}>{tr("AI coding agent chat inside VS Code — local, open source.")}</div>
                </div>
              </div>
              <Group>
                <Row title={tr("Author")} desc={tr("Created and maintained by Yao.")}>
                  <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "openExternal", url: "https://github.com/westhack" })}>{tr("GitHub ↗")}</button>
                </Row>
                <Row title={tr("Repository")} desc={tr("Source code, issues and contributions.")}>
                  <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "openExternal", url: "https://github.com/westhack/ai-work-harness-vs" })}>{tr("Open ↗")}</button>
                </Row>
                <Row title={tr("Report an Issue")} desc={tr("Found a bug or have a feature request?")}>
                  <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "openExternal", url: "https://github.com/westhack/ai-work-harness-vs/issues" })}>{tr("Issues ↗")}</button>
                </Row>
                <Row title={tr("License")} desc={tr("Free and open source under the MIT License.")}>
                  <span className="badge-tag glob">{tr("MIT")}</span>
                </Row>
              </Group>
              <p className="panel-hint">{tr("Copyright © 2026 Yao. Licensed under the MIT License.")}</p>
            </>
          )}

        </div>
        </div>
        <footer className="settings-actions" aria-label={tr("Settings actions")}>
          <div className="settings-actions-inner">
            <button className="btn-save" onClick={save}>{tr("Save")}</button>
          </div>
        </footer>
      </main>
    </div>
  );
}
