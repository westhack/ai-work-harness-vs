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
import { Icon } from "../../shared/icons";
import { Select } from "../../shared/Select";
import { FeatureConfig } from "../features";
import { Toggle } from "./Toggle";
import { t as tr } from "../../shared/i18n";

type MemoryScope = "global" | "project";

interface MemoryEntry {
	id: string;
	text: string;
	tags: string[];
	scope: MemoryScope;
	createdAt: number;
	updatedAt: number;
}

/** Parse comma/space separated tags, mirroring the store's de-duplication. */
function parseTags(value: string): string[] {
	return [...new Set(value.split(/[,;\n]+/).map((tag) => tag.trim()).filter(Boolean))];
}

export function MemoryPanel({
	features,
	setFeatures,
}: {
	features: FeatureConfig;
	setFeatures: (f: Partial<FeatureConfig>) => void;
}) {
	const [entries, setEntries] = React.useState<MemoryEntry[]>([]);
	const [hasWorkspace, setHasWorkspace] = React.useState(true);
	const [projectPath, setProjectPath] = React.useState("");
	const [globalPath, setGlobalPath] = React.useState("");
	const [error, setError] = React.useState("");
	const [text, setText] = React.useState("");
	const [tags, setTags] = React.useState("");
	const [scope, setScope] = React.useState<MemoryScope>("project");
	const [editingId, setEditingId] = React.useState<string | null>(null);
	const [editText, setEditText] = React.useState("");
	const [editTags, setEditTags] = React.useState("");

	React.useEffect(() => {
		const handler = (event: MessageEvent) => {
			const msg = event.data;
			if (msg?.type !== "memoryList") return;
			setEntries(Array.isArray(msg.entries) ? msg.entries : []);
			setHasWorkspace(msg.hasWorkspace !== false);
			setProjectPath(typeof msg.projectPath === "string" ? msg.projectPath : "");
			setGlobalPath(typeof msg.globalPath === "string" ? msg.globalPath : "");
			setError(typeof msg.error === "string" ? msg.error : "");
		};
		window.addEventListener("message", handler);
		vscode.postMessage({ type: "getMemory" });
		return () => window.removeEventListener("message", handler);
	}, []);

	const canSave = !!text.trim() && (scope === "global" || hasWorkspace);
	const add = () => {
		if (!canSave) return;
		vscode.postMessage({ type: "addMemory", text, tags: parseTags(tags), scope });
		setText("");
		setTags("");
	};
	const startEdit = (entry: MemoryEntry) => {
		setEditingId(entry.id);
		setEditText(entry.text);
		setEditTags(entry.tags.join(", "));
	};
	const saveEdit = () => {
		if (!editingId || !editText.trim()) return;
		vscode.postMessage({ type: "updateMemory", id: editingId, text: editText, tags: parseTags(editTags) });
		setEditingId(null);
	};
	const remove = (entry: MemoryEntry) => vscode.postMessage({ type: "deleteMemory", id: entry.id });
	const clear = (target: MemoryScope) => {
		const question = target === "global"
			? tr("Delete all global memories? This cannot be undone.")
			: tr("Delete all project memories? This cannot be undone.");
		if (!window.confirm(question)) return;
		vscode.postMessage({ type: "clearMemory", scope: target });
	};

	const projectEntries = entries.filter((entry) => entry.scope === "project");
	const globalEntries = entries.filter((entry) => entry.scope === "global");

	return (
		<>
			<h1 className="page-title">{tr("Memory")}</h1>
			<p className="panel-hint">
				{tr("Durable notes the agent saved for future chats. Project memories apply to this workspace; global memories apply everywhere. Secrets are never stored.")}
			</p>

			<div className="row">
				<div className="row-text">
					<div className="row-title">{tr("Inject memories")}</div>
					<div className="row-desc">{tr("Add the most relevant entries to each new request.")}</div>
				</div>
				<Toggle checked={features.memoryEnabled !== false} onChange={(v) => setFeatures({ memoryEnabled: v })} />
			</div>
			<div className="row">
				<div className="row-text">
					<div className="row-title">{tr("Max injected entries")}</div>
					<div className="row-desc">{tr("Upper bound per message (1–50). Older or unrelated entries stay searchable with the Memory tool.")}</div>
				</div>
				<input
					type="number"
					min={1}
					max={50}
					style={{ width: 90 }}
					value={features.memoryInjectLimit ?? 12}
					onChange={(e) => {
						const next = Number.parseInt(e.target.value, 10);
						if (Number.isFinite(next)) setFeatures({ memoryInjectLimit: Math.max(1, Math.min(50, next)) });
					}}
				/>
			</div>

			<div className="section-label" style={{ marginTop: 24 }}>{tr("Add Memory")}</div>
			<div className="feature-card">
				<div className="fc-body">
					<label className="fc-field">
						<span>{tr("Text")}</span>
						<textarea rows={3} value={text} maxLength={2000} placeholder={tr("A durable preference or fact the agent should remember.")} onChange={(e) => setText(e.target.value)} />
					</label>
					<label className="fc-field">
						<span>{tr("Tags")}</span>
						<input value={tags} placeholder={tr("optional, comma separated")} onChange={(e) => setTags(e.target.value)} />
					</label>
					<label className="fc-field">
						<span>{tr("Scope")}</span>
						<Select value={scope} onChange={(e) => setScope(e.target.value === "global" ? "global" : "project")}>
							<option value="project">{tr("Project")}</option>
							<option value="global">{tr("Global")}</option>
						</Select>
					</label>
				</div>
			</div>
			<div className="panel-actions">
				<button className="btn-ghost" disabled={!canSave} onClick={add}>
					<Icon name="plus" size={14} /> {tr("Add Memory")}
				</button>
				{!hasWorkspace && <span className="row-desc">{tr("Open a workspace to add project memories, or choose Global scope.")}</span>}
			</div>

			{error && <div className="row-desc engine-status-error">{tr(error)}</div>}

			<div className="section-label" style={{ marginTop: 24 }}>
				{tr("Saved Memories")} ({entries.length})
			</div>
			{entries.length === 0 && <p className="panel-hint">{tr("No memories yet. Ask the agent to remember a preference, or add one above.")}</p>}

			{projectEntries.length > 0 && (
				<>
					<div className="row">
						<div className="row-text">
							<div className="row-title">{tr("Project")} ({projectEntries.length})</div>
							{projectPath && <div className="row-desc">{projectPath}</div>}
						</div>
						<button className="btn-secondary" disabled={!hasWorkspace} onClick={() => clear("project")}>{tr("Clear")}</button>
					</div>
					{projectEntries.map((entry) => (
						<MemoryCard key={entry.id} entry={entry} editing={editingId === entry.id} editText={editText} editTags={editTags} setEditText={setEditText} setEditTags={setEditTags} startEdit={() => startEdit(entry)} cancelEdit={() => setEditingId(null)} saveEdit={saveEdit} remove={() => remove(entry)} />
					))}
				</>
			)}

			{globalEntries.length > 0 && (
				<>
					<div className="row">
						<div className="row-text">
							<div className="row-title">{tr("Global")} ({globalEntries.length})</div>
							{globalPath && <div className="row-desc">{globalPath}</div>}
						</div>
						<button className="btn-secondary" onClick={() => clear("global")}>{tr("Clear")}</button>
					</div>
					{globalEntries.map((entry) => (
						<MemoryCard key={entry.id} entry={entry} editing={editingId === entry.id} editText={editText} editTags={editTags} setEditText={setEditText} setEditTags={setEditTags} startEdit={() => startEdit(entry)} cancelEdit={() => setEditingId(null)} saveEdit={saveEdit} remove={() => remove(entry)} />
					))}
				</>
			)}
		</>
	);
}

function MemoryCard({
	entry,
	editing,
	editText,
	editTags,
	setEditText,
	setEditTags,
	startEdit,
	cancelEdit,
	saveEdit,
	remove,
}: {
	entry: MemoryEntry;
	editing: boolean;
	editText: string;
	editTags: string;
	setEditText: (value: string) => void;
	setEditTags: (value: string) => void;
	startEdit: () => void;
	cancelEdit: () => void;
	saveEdit: () => void;
	remove: () => void;
}) {
	return (
		<div className="feature-card">
			<div className="fc-head">
				<span className="badge-default">{tr(entry.scope === "global" ? "Global" : "Project")}</span>
				<div style={{ flex: 1 }} />
				{editing ? (
					<>
						<button className="btn-secondary" onClick={cancelEdit}>{tr("Cancel")}</button>
						<button className="btn-secondary" disabled={!editText.trim()} onClick={saveEdit}>{tr("Save")}</button>
					</>
				) : (
					<>
						<button className="icon-btn" onClick={startEdit} title={tr("Edit")}>
							<Icon name="edit" size={14} />
						</button>
						<button className="icon-btn" onClick={remove} title={tr("Delete")}>
							<Icon name="trash" size={14} />
						</button>
					</>
				)}
			</div>
			<div className="fc-body">
				{editing ? (
					<>
						<label className="fc-field">
							<span>{tr("Text")}</span>
							<textarea rows={3} value={editText} maxLength={2000} onChange={(e) => setEditText(e.target.value)} />
						</label>
						<label className="fc-field">
							<span>{tr("Tags")}</span>
							<input value={editTags} placeholder={tr("optional, comma separated")} onChange={(e) => setEditTags(e.target.value)} />
						</label>
					</>
				) : (
					<>
						<div className="lr-desc" style={{ whiteSpace: "pre-wrap" }}>{entry.text}</div>
						{entry.tags.length > 0 && <div className="row-desc">{entry.tags.join(", ")}</div>}
					</>
				)}
			</div>
		</div>
	);
}
