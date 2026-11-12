/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { spawn } from "node:child_process";
import * as fs from "fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

/** Exit code + raw stdout of one git invocation (bytes are exact, for `git show`). */
export interface GitResult { code: number; stdout: Buffer }
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;
/** Injected so tests never spawn real git or touch a real filesystem. */
export interface ChangeTrackingDeps {
	git: GitRunner;
	readFile: (file: string) => Promise<Buffer>;
}

/** One net file change made by an external engine during its turn. */
export interface TrackedChange {
	path: string;
	/** Pre-run content; null when the file did not exist before the turn. */
	before: Buffer | null;
	/** Post-run disk content; null when the file was deleted by the turn. */
	after: Buffer | null;
	existedBefore: boolean;
}

/**
 * Repository state captured before an external engine turn. Tracked-but-clean
 * files need no snapshot — their pre-run content is HEAD, fetched on demand.
 */
export interface ExternalChangeSnapshot {
	repoRoot: string;
	/** Tracked files already modified/staged/deleted before the run: pre-run disk content (null = already deleted). */
	dirtyAtStart: Map<string, Buffer | null>;
	/** Untracked files present before the run: pre-run disk content. */
	untrackedAtStart: Map<string, Buffer | null>;
	/** Files whose pre-run content could not be read; never attributed to the engine. */
	unreadableAtStart: Set<string>;
}

const GIT_TIMEOUT_MS = 10_000;

function spawnGit(args: string[], cwd: string): Promise<GitResult> {
	return new Promise((resolve) => {
		// Read-only git must not execute the repository's external fsmonitor.
		const child = spawn("git", ["-c", "core.fsmonitor=false", ...args], { cwd, windowsHide: true });
		let out = Buffer.alloc(0);
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; child.kill(); }, GIT_TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => { out = Buffer.concat([out, chunk]); });
		child.on("error", () => { clearTimeout(timer); resolve({ code: -1, stdout: Buffer.alloc(0) }); });
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: timedOut ? 124 : code ?? -1, stdout: out });
		});
	});
}

const digest = (bytes: Buffer | null): string =>
	bytes === null ? "deleted" : createHash("sha256").update(bytes).digest("hex");

/** Comparison key for paths; the pending-edit store lowercases on Windows too. */
const pathKey = (file: string): string => (process.platform === "win32" ? file.toLowerCase() : file);

const isInside = (root: string, file: string): boolean => {
	const rel = path.relative(root, file);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

async function repoRoot(git: GitRunner, cwd: string): Promise<string | null> {
	const result = await git(["rev-parse", "--show-toplevel"], cwd);
	const root = result.stdout.toString("utf8").trim();
	return result.code === 0 && root ? root : null;
}

/** `git status --porcelain=v1 -z` entries: `XY <path>`, with a rename's source path as an extra NUL field. */
function parsePorcelain(stdout: Buffer): { status: string; file: string }[] {
	const entries: { status: string; file: string }[] = [];
	const tokens = stdout.toString("utf8").split("\0");
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.length < 4) continue;
		const status = token.slice(0, 2);
		entries.push({ status, file: token.slice(3) });
		if (status.includes("R") || status.includes("C")) i++; // skip the original-path token
	}
	return entries;
}

/** Missing files read as null; other read failures propagate (callers decide). */
async function readPresent(readFile: (file: string) => Promise<Buffer>, file: string): Promise<Buffer | null> {
	try { return await readFile(file); } catch (error: any) { if (error?.code === "ENOENT") return null; throw error; }
}

function defaultDeps(): ChangeTrackingDeps {
	return { git: spawnGit, readFile: (file) => fs.readFile(file) };
}

/**
 * Capture pre-run content of tracked-but-dirty and untracked files so an
 * external engine's writes can be diffed afterwards. Returns null outside a
 * git repository (or when git fails); callers then skip change tracking.
 */
export async function takeExternalChangeSnapshot(root: string, deps?: Partial<ChangeTrackingDeps>): Promise<ExternalChangeSnapshot | null> {
	const d = { ...defaultDeps(), ...deps };
	const top = await repoRoot(d.git, root);
	if (!top) return null;
	const status = await d.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], top);
	if (status.code !== 0) return null;
	const dirtyAtStart = new Map<string, Buffer | null>();
	const untrackedAtStart = new Map<string, Buffer | null>();
	const unreadableAtStart = new Set<string>();
	for (const { status: code, file } of parsePorcelain(status.stdout)) {
		const abs = path.join(top, file);
		try {
			const content = await readPresent(d.readFile, abs);
			if (code === "??") untrackedAtStart.set(abs, content);
			else dirtyAtStart.set(abs, content);
		} catch { unreadableAtStart.add(abs); }
	}
	return { repoRoot: top, dirtyAtStart, untrackedAtStart, unreadableAtStart };
}

/**
 * Every file currently differing from HEAD after the turn — tracked edits and
 * deletions (status + diff) and untracked additions (status) — resolved to
 * absolute paths inside the workspace root.
 */
export async function collectChangedNow(root: string, deps?: Partial<ChangeTrackingDeps>): Promise<string[]> {
	const d = { ...defaultDeps(), ...deps };
	const top = await repoRoot(d.git, root);
	if (!top) return [];
	const [status, diff] = await Promise.all([
		d.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], top),
		d.git(["diff", "--name-only", "-z", "HEAD"], top),
	]);
	const files = new Set<string>();
	if (status.code === 0) {
		for (const { file } of parsePorcelain(status.stdout)) if (file) files.add(path.join(top, file));
	}
	if (diff.code === 0) {
		for (const file of diff.stdout.toString("utf8").split("\0")) if (file) files.add(path.join(top, file));
	}
	return [...files].filter((file) => isInside(root, file));
}

/**
 * Fold the post-run change set into pending-change records attributed to the
 * external engine's turn. When the engine named any file through its tool
 * events (touchedPaths non-empty) only those files are recorded; otherwise
 * every changed file is. Files whose content is net-identical are skipped.
 */
export async function computeExternalChanges(
	root: string,
	snapshot: ExternalChangeSnapshot,
	touchedPaths: string[],
	changedNow: string[],
	deps?: Partial<ChangeTrackingDeps>,
): Promise<TrackedChange[]> {
	const d = { ...defaultDeps(), ...deps };
	const touched = new Set(touchedPaths.map(pathKey));
	const records: TrackedChange[] = [];
	for (const file of changedNow) {
		if (!isInside(root, file)) continue;
		if (touched.size > 0 && !touched.has(pathKey(file))) continue;
		if (snapshot.unreadableAtStart.has(file)) continue;
		try {
			const after = await readPresent(d.readFile, file);
			let before: Buffer | null;
			if (snapshot.dirtyAtStart.has(file)) before = snapshot.dirtyAtStart.get(file) ?? null;
			else if (snapshot.untrackedAtStart.has(file)) before = snapshot.untrackedAtStart.get(file) ?? null;
			else {
				// Clean tracked file: its pre-run content is the HEAD blob.
				const rel = path.relative(snapshot.repoRoot, file).split(path.sep).join("/");
				const head = await d.git(["show", `HEAD:${rel}`], snapshot.repoRoot);
				before = head.code === 0 ? head.stdout : null;
			}
			if (digest(before) === digest(after)) continue;
			records.push({ path: file, before, after, existedBefore: before !== null });
		} catch { /* one unreadable file must not drop the records of the others */ }
	}
	return records;
}
