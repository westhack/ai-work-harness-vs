/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { spawn, execFile, type SpawnOptions } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEngine, EngineId } from "./types";
import { claudeCodeEngine } from "./claudeCode";
import { openCodeEngine } from "./openCode";
import { dshEngine } from "./dsh";
import { createAcpEngine } from "./acp";
import { codexEngine } from "./codex";

const exec = promisify(execFile);

const COMMANDS: Record<Exclude<EngineId, "builtin">, string> = {
	"claude-code": "claude",
	opencode: "opencode",
	dsh: "dsh",
	gemini: "gemini",
	qwen: "qwen",
	kimi: "kimi",
	crush: "crush",
	zcode: "zcode",
	pi: "pi",
	codex: "codex",
};

/**
 * Version-sensitive launch flags for the ACP/Codex adapters, kept in one place
 * so adapters stay thin. gemini/qwen follow their documented ACP mode; kimi,
 * crush, zcode and pi flags are TODO(unverified) — confirm each CLI's ACP
 * subcommand and adjust here.
 */
export const ENGINE_LAUNCH_ARGS: Partial<Record<Exclude<EngineId, "builtin">, string[]>> = {
	gemini: ["--experimental-acp"],
	qwen: ["--experimental-acp"],
	kimi: ["acp"],
	crush: ["acp"],
	zcode: ["acp"], // TODO: verify the zcode ACP subcommand
	pi: ["--mode", "acp"], // TODO: verify the pi ACP mode flag
	codex: ["exec", "--json", "--sandbox", "workspace-write"],
	dsh: ["web"],
};

/**
 * Locate a CLI on PATH. On Windows `where.exe` lists every match, so prefer
 * real executables/shims over PowerShell scripts (which cannot be spawned).
 */
export async function whereBinary(command: string): Promise<string | undefined> {
	const finder = process.platform === "win32" ? "where.exe" : "which";
	try {
		const { stdout } = await exec(finder, [command], { windowsHide: true });
		const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		return lines.find((line) => /\.(exe|cmd|bat)$/i.test(line)) ?? lines.find((line) => !/\.ps1$/i.test(line)) ?? lines[0];
	} catch {
		return undefined;
	}
}

/** Claude Code also ships a native binary inside its VS Code extension. */
function latestClaudeExtensionBinary(): string | undefined {
	try {
		const extensionsDir = join(homedir(), ".vscode", "extensions");
		if (!existsSync(extensionsDir)) return undefined;
		const candidates: { path: string; mtime: number }[] = [];
		for (const entry of readdirSync(extensionsDir)) {
			if (!/^anthropic\.claude-code-/.test(entry)) continue;
			const binary = join(extensionsDir, entry, "resources", "native-binary", "claude.exe");
			if (!existsSync(binary)) continue;
			candidates.push({ path: binary, mtime: statSync(binary).mtimeMs });
		}
		candidates.sort((a, b) => b.mtime - a.mtime);
		return candidates[0]?.path;
	} catch {
		return undefined;
	}
}

/** Where the resolved executable was found, shown in the settings list. */
export type EngineBinarySource = "override" | "extension" | "path" | "vscode-extension";

export type EngineBinaryInfo = { path: string; source: EngineBinarySource };

/** `<globalStorage>/engines`, where installs are prefixed per engine. */
let localEnginesRoot: string | undefined;

/** Paths the user picked for their own CLI installs. */
let engineOverrides: Partial<Record<EngineId, string>> = {};

/** Resolved binaries, cached per (engine id + effective override). */
const binaryCache = new Map<string, EngineBinaryInfo | undefined>();

/** Point resolution at the extension-owned engines folder (undefined = disabled). */
export function setLocalEnginesRoot(dir: string | undefined): void {
	localEnginesRoot = dir?.trim() || undefined;
	clearEngineCaches();
}

export function getLocalEnginesRoot(): string | undefined {
	return localEnginesRoot;
}

/** Replace the persisted per-engine overrides; empty values are not stored. */
export function setEngineOverrides(paths: Partial<Record<EngineId, string>> | undefined): void {
	const next: Partial<Record<EngineId, string>> = {};
	for (const [id, value] of Object.entries(paths ?? {})) {
		if (typeof value === "string" && value.trim()) next[id as EngineId] = value.trim();
	}
	engineOverrides = next;
	clearEngineCaches();
}

/** An explicit argument wins over the persisted override. */
function effectiveOverride(id: EngineId, override?: string): string | undefined {
	return override?.trim() || engineOverrides[id]?.trim() || undefined;
}

/** The effective override must be part of the key: it can change after a save. */
function cacheKey(id: EngineId, override?: string): string {
	return `${id}:${effectiveOverride(id, override) ?? ""}`;
}

/** `engines/<id>/node_modules/.bin/<cmd>` — Windows ships .cmd shims. */
function localEngineBinary(id: Exclude<EngineId, "builtin">): string | undefined {
	if (!localEnginesRoot) return undefined;
	const base = join(localEnginesRoot, id, "node_modules", ".bin", COMMANDS[id]);
	const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
	for (const extension of extensions) {
		const candidate = `${base}${extension}`;
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Override → extension-owned install → PATH → Claude Code's VS Code extension.
 * The source travels back so the settings UI can explain where it came from.
 */
export async function describeEngineBinary(id: EngineId, override?: string): Promise<EngineBinaryInfo | undefined> {
	if (id === "builtin") return undefined;
	const key = cacheKey(id, override);
	if (binaryCache.has(key)) return binaryCache.get(key);
	let info: EngineBinaryInfo | undefined;
	const chosen = effectiveOverride(id, override);
	if (chosen) info = { path: chosen, source: "override" };
	if (!info) {
		const local = localEngineBinary(id as Exclude<EngineId, "builtin">);
		if (local) info = { path: local, source: "extension" };
	}
	if (!info) {
		const onPath = await whereBinary(COMMANDS[id as Exclude<EngineId, "builtin">]);
		if (onPath) info = { path: onPath, source: "path" };
	}
	if (!info && id === "claude-code") {
		const extensionBinary = latestClaudeExtensionBinary();
		if (extensionBinary) info = { path: extensionBinary, source: "vscode-extension" };
	}
	binaryCache.set(key, info);
	return info;
}

/** Override → extension folder → PATH lookup → extension glob. */
export async function resolveEngineBinary(id: EngineId, override?: string): Promise<string | undefined> {
	return (await describeEngineBinary(id, override))?.path;
}

/** Spawn a CLI, routing through cmd.exe for Windows .cmd/.bat shims. */
export function spawnCommand(binary: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	const opts: SpawnOptions = {
		cwd: options.cwd,
		...(options.env ? { env: { ...process.env, ...options.env } } : {}),
		windowsHide: true,
		stdio: "pipe",
	};
	if (process.platform === "win32" && /\.(cmd|bat)$/i.test(binary)) {
		return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", binary, ...args], opts);
	}
	return spawn(binary, args, opts);
}

/** Best-effort tree kill; plain SIGTERM elsewhere. */
export function killProcessTree(pid: number | undefined): void {
	if (!pid) return;
	if (process.platform === "win32") {
		try { spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }); } catch { /* best effort */ }
	} else {
		try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
	}
}

const availabilityCache = new Map<string, { ok: boolean; detail?: string }>();

/** Availability results cached module-level by (engine id + resolved binary). */
export async function cachedAvailability(
	id: EngineId,
	binaryPath: string | undefined,
	probe: () => Promise<{ ok: boolean; detail?: string }>,
): Promise<{ ok: boolean; detail?: string }> {
	const key = `${id}:${binaryPath ?? ""}`;
	const cached = availabilityCache.get(key);
	if (cached) return cached;
	const result = await probe();
	availabilityCache.set(key, result);
	return result;
}

/**
 * Forget cached lookup results so a freshly installed CLI (or a changed PATH)
 * is probed again on the next status request. Omit `id` to clear everything.
 */
export function clearEngineCaches(id?: EngineId): void {
	const prefix = id ? `${id}:` : undefined;
	for (const key of [...binaryCache.keys()]) {
		if (!prefix || key.startsWith(prefix)) binaryCache.delete(key);
	}
	for (const key of [...availabilityCache.keys()]) {
		if (!prefix || key.startsWith(prefix)) availabilityCache.delete(key);
	}
}

const builtinEngine: AgentEngine = {
	id: "builtin",
	label: "Built-in (recommended)",
	available: () => Promise.resolve({ ok: true }),
	run: () => Promise.reject(new Error("The built-in engine runs through runAgent and has no external adapter")),
};

/** Every selectable engine, in settings order. */
export function listEngines(): AgentEngine[] {
	const acpEngines: AgentEngine[] = [
		createAcpEngine("gemini", "Gemini CLI", ENGINE_LAUNCH_ARGS.gemini ?? []),
		createAcpEngine("qwen", "Qwen Code", ENGINE_LAUNCH_ARGS.qwen ?? []),
		createAcpEngine("kimi", "Kimi CLI", ENGINE_LAUNCH_ARGS.kimi ?? []),
		createAcpEngine("crush", "Crush", ENGINE_LAUNCH_ARGS.crush ?? []),
		createAcpEngine("zcode", "ZCode", ENGINE_LAUNCH_ARGS.zcode ?? []),
		createAcpEngine("pi", "pi", ENGINE_LAUNCH_ARGS.pi ?? []),
	];
	return [builtinEngine, claudeCodeEngine, openCodeEngine, dshEngine, ...acpEngines, codexEngine];
}

export function getEngine(id: EngineId): AgentEngine | undefined {
	return listEngines().find((engine) => engine.id === id);
}
