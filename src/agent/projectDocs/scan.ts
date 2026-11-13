/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProjectDocPage } from "./store";

const execFileAsync = promisify(execFile);

/** Folders that never contribute useful documentation context. */
const SKIP_DIRS = new Set([
	"node_modules", ".git", "dist", "out", "build", ".next", ".nuxt", ".output",
	".turbo", ".cache", "coverage", ".venv", "venv", "__pycache__", ".mypy_cache",
	".pytest_cache", "target", "vendor", "Pods", ".gradle", ".idea", ".vscode",
	"bower_components", ".pnpm-store", ".yarn", "site-packages", ".terraform",
	".svelte-kit", ".angular", "storybook-static", "playwright-report", "test-results",
	".nyc_output", "htmlcov", "graphify-out",
]);

/**
 * Only binaries are excluded; every text file (XML, properties, Gradle,
 * Dockerfile, lock files, …) is kept so modules cannot disappear from context.
 * Mirrors the reference scanner instead of maintaining an extension allowlist.
 */
const BINARY_SUFFIXES = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".tiff", ".psd",
	".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
	".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar",
	".jar", ".war", ".ear", ".class", ".dll", ".exe", ".so", ".dylib", ".a", ".o",
	".obj", ".lib", ".pdb", ".pyc", ".pyo", ".whl",
	".woff", ".woff2", ".ttf", ".otf", ".eot",
	".db", ".sqlite", ".sqlite3", ".mdb",
	".pem", ".key", ".p12", ".pfx", ".jks", ".keystore",
	".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac", ".ogg", ".webm",
	".iso", ".dmg", ".bin", ".dat", ".pak", ".wasm", ".node",
]);

/** Credentials must never be sent to a model, even when they are plain text. */
const SECRET_NAMES = new Set([
	"credentials.json", "secrets.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
]);

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DEPTH = 12;

export interface ScannedFile {
	/** Workspace-relative POSIX path. */
	path: string;
	size: number;
}

export interface ScanOptions {
	/** Stop after this many files (default 8000). */
	maxFiles?: number;
	/** Skip files larger than this many bytes (default 1 MB). */
	maxFileBytes?: number;
}

/** Walk the workspace once; the catalog prompt and source gathering share it. */
export async function scanWorkspace(root: string, options: ScanOptions = {}): Promise<ScannedFile[]> {
	const maxFiles = options.maxFiles && options.maxFiles > 0 ? options.maxFiles : 8000;
	const maxFileBytes = options.maxFileBytes && options.maxFileBytes > 0 ? options.maxFileBytes : MAX_FILE_BYTES;
	const files: ScannedFile[] = [];
	const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
		if (depth > MAX_DEPTH || files.length >= maxFiles) return;
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (files.length >= maxFiles) return;
			if (entry.name.startsWith(".")) {
				// Dot files are caches or editor state (and .env holds secrets).
				continue;
			}
			const abs = join(directory, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				await walk(abs, rel, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			const lower = entry.name.toLowerCase();
			if (SECRET_NAMES.has(lower)) continue;
			const dot = lower.lastIndexOf(".");
			if (dot > 0 && BINARY_SUFFIXES.has(lower.slice(dot))) continue;
			try {
				const info = await stat(abs);
				if (info.size > maxFileBytes) continue;
				files.push({ path: rel, size: info.size });
			} catch {
				/* unreadable file: skip it */
			}
		}
	};
	await walk(root, "", 0);
	return files;
}

/** Compile a simple glob (`, *, ?, **`) into an anchored regular expression. */
export function globToRegExp(pattern: string): RegExp {
	const normalized = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
	let source = "";
	for (let index = 0; index < normalized.length; index++) {
		const char = normalized[index];
		if (char === "*") {
			if (normalized[index + 1] === "*") {
				index++;
				if (normalized[index + 1] === "/") {
					index++;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}
		if (char === "?") { source += "[^/]"; continue; }
		source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`, "i");
}

/** True when a workspace-relative path matches a catalog source pattern. */
export function matchesSource(pattern: string, path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	const target = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (!target) return false;
	if (!target.includes("/")) {
		const name = normalized.slice(normalized.lastIndexOf("/") + 1);
		return globToRegExp(target).test(name) || globToRegExp(`**/${target}`).test(normalized);
	}
	return globToRegExp(target).test(normalized);
}

/** Files selected by a page's source patterns, in catalog order and deduplicated. */
export function selectSourceFiles(sources: string[], files: ScannedFile[], limit = 24): ScannedFile[] {
	const selected: ScannedFile[] = [];
	const seen = new Set<string>();
	for (const source of sources) {
		for (const file of files) {
			if (seen.has(file.path) || !matchesSource(source, file.path)) continue;
			seen.add(file.path);
			selected.push(file);
			if (selected.length >= limit) return selected;
		}
	}
	return selected;
}

/** Concatenated file excerpts, capped so one huge file cannot eat the budget. */
export async function readSourceExcerpts(
	root: string,
	files: ScannedFile[],
	budgetChars = 60_000,
	perFileChars = 8_000,
): Promise<string> {
	const parts: string[] = [];
	let used = 0;
	for (const file of files) {
		if (used >= budgetChars) break;
		let text: string;
		try {
			text = await readFile(join(root, ...file.path.split("/")), "utf8");
		} catch {
			continue;
		}
		const cap = Math.min(perFileChars, budgetChars - used);
		const excerpt = text.length > cap ? `${text.slice(0, cap)}\n… (truncated)` : text;
		parts.push(`--- ${file.path} ---\n${excerpt}`);
		used += excerpt.length;
	}
	return parts.join("\n\n");
}

/** Pages whose source globs touch any of the changed files. */
export function affectedPages(pages: ProjectDocPage[], changed: string[]): ProjectDocPage[] {
	if (!changed.length) return [];
	return pages.filter((page) => changed.some((path) => page.sources.some((source) => matchesSource(source, path))));
}

/** Best-effort git helpers; docs must keep working outside a repository. */
export async function gitOutput(root: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", root, ...args], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
		return stdout;
	} catch {
		return undefined;
	}
}

export async function gitHead(root: string): Promise<string | undefined> {
	const value = (await gitOutput(root, ["rev-parse", "--short", "HEAD"]))?.trim();
	return value || undefined;
}

/** Files modified since `commit`, plus uncommitted edits, as workspace paths. */
export async function changedSince(root: string, commit: string | undefined): Promise<string[]> {
	const changed = new Set<string>();
	if (commit) {
		const diff = await gitOutput(root, ["diff", "--name-only", `${commit}..HEAD`]);
		for (const line of diff?.split(/\r?\n/) ?? []) if (line.trim()) changed.add(line.trim());
	}
	const status = await gitOutput(root, ["status", "--porcelain"]);
	for (const line of status?.split(/\r?\n/) ?? []) {
		const path = line.slice(3).trim();
		if (!path) continue;
		const rename = path.split(" -> ").pop();
		if (rename) changed.add(rename);
	}
	return [...changed];
}
