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
import { delimiter, join } from "node:path";
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
 * On macOS/Linux the login shell answers instead: an editor launched from the
 * Dock inherits a minimal PATH without Homebrew, nvm or `~/.local/bin`.
 */
export async function whereBinary(command: string): Promise<string | undefined> {
	if (process.platform !== "win32") {
		const viaShell = await execFileText("/bin/sh", ["-lc", 'command -v -- "$1"', "sh", command]);
		const found = viaShell?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
		if (found) return found;
		const viaWhich = await execFileText("which", [command]);
		return viaWhich?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
	}
	try {
		const { stdout } = await exec("where.exe", [command], { windowsHide: true });
		const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		return lines.find((line) => /\.(exe|cmd|bat)$/i.test(line)) ?? lines.find((line) => !/\.ps1$/i.test(line)) ?? lines[0];
	} catch {
		return undefined;
	}
}

async function execFileText(file: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout } = await exec(file, args, { timeout: 8_000, env: engineEnv() });
		return String(stdout);
	} catch {
		return undefined;
	}
}

/** POSIX dirs that package managers use but a GUI-launched editor often omits. */
export function commonPosixBinDirs(home = homedir()): string[] {
	return [
		"/opt/homebrew/bin",
		"/usr/local/bin",
		join(home, ".local", "bin"),
		join(home, ".npm-global", "bin"),
		join(home, ".bun", "bin"),
	];
}

let shellPathPrefix: string[] | undefined;

/**
 * Read the login shell's PATH once at activation. Everything spawned through
 * {@link engineEnv} then sees the same tools the user's terminal does.
 */
export async function primeShellPath(): Promise<void> {
	if (process.platform === "win32" || shellPathPrefix) return;
	const shell = process.env.SHELL || "/bin/sh";
	// Markers keep profile banner noise (nvm, pyenv, …) out of the captured PATH.
	const text = await execFileText(shell, ["-ilc", 'printf "__AWH_PATH__%s__AWH_END__" "$PATH"']);
	const captured = /__AWH_PATH__([\s\S]*?)__AWH_END__/.exec(text ?? "")?.[1] ?? "";
	shellPathPrefix = captured.split(":").map((dir) => dir.trim()).filter(Boolean);
}

/** Test seam: forget the cached login-shell PATH. */
export function resetShellPath(): void {
	shellPathPrefix = undefined;
}

function augmentedPath(): string | undefined {
	if (process.platform === "win32") return undefined;
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const dir of [...(shellPathPrefix ?? []), ...commonPosixBinDirs(), ...(process.env.PATH ?? "").split(delimiter)]) {
		if (!dir || seen.has(dir)) continue;
		seen.add(dir);
		parts.push(dir);
	}
	return parts.join(delimiter);
}

/** Process env for spawned CLIs, with the augmented POSIX PATH applied. */
function engineEnv(): NodeJS.ProcessEnv {
	const path = augmentedPath();
	return path ? { ...process.env, PATH: path } : { ...process.env };
}

/** Editor variants keep extensions in different folders. */
export function claudeExtensionDirs(home = homedir()): string[] {
	return [
		join(home, ".vscode", "extensions"),
		join(home, ".vscode-server", "extensions"),
		join(home, ".vscode-oss", "extensions"),
		join(home, ".cursor", "extensions"),
		join(home, ".windsurf", "extensions"),
		join(home, ".trae", "extensions"),
		join(home, ".trae-cn", "extensions"),
	];
}

/** The native binary is `claude.exe` on Windows and `claude` elsewhere. */
export function claudeBinaryNames(platform: NodeJS.Platform = process.platform): string[] {
	return platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
}

/** Claude Code also ships a native binary inside its editor extension. */
function latestClaudeExtensionBinary(): string | undefined {
	try {
		const names = claudeBinaryNames();
		const candidates: { path: string; mtime: number }[] = [];
		for (const extensionsDir of claudeExtensionDirs()) {
			if (!existsSync(extensionsDir)) continue;
			for (const entry of readdirSync(extensionsDir)) {
				if (!/^anthropic\.claude-code-/.test(entry)) continue;
				for (const name of names) {
					const binary = join(extensionsDir, entry, "resources", "native-binary", name);
					if (!existsSync(binary)) continue;
					candidates.push({ path: binary, mtime: statSync(binary).mtimeMs });
				}
			}
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

/** `<globalStorage>/engines/<id>` when extension-scoped installs are enabled. */
export function engineInstallDirectory(id: string): string | undefined {
	if (!localEnginesRoot || !id.trim()) return undefined;
	return join(localEnginesRoot, id);
}

/** The path the user picked for this engine, if any. */
export function getEngineOverride(id: EngineId): string | undefined {
	return engineOverrides[id]?.trim() || undefined;
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
	const env = engineEnv();
	if (options.env) Object.assign(env, options.env);
	const opts: SpawnOptions = {
		cwd: options.cwd,
		env,
		windowsHide: true,
		stdio: "pipe",
		// POSIX: own process group so killProcessTree can take children down too.
		detached: process.platform !== "win32",
	};
	if (process.platform === "win32" && /\.(cmd|bat)$/i.test(binary)) {
		// cmd.exe needs the shim quoted itself when the path has spaces.
		const shim = /\s/.test(binary) ? `"${binary}"` : binary;
		return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", shim, ...args], opts);
	}
	return spawn(binary, args, opts);
}

/** Best-effort tree kill: taskkill on Windows, process group then children on POSIX. */
export function killProcessTree(pid: number | undefined): void {
	if (!pid) return;
	if (process.platform === "win32") {
		try { spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }); } catch { /* best effort */ }
		return;
	}
	// The CLI may have been started in its own group; try the group first so
	// helper processes (MCP servers, tool subprocesses) go down with it.
	try { process.kill(-pid, "SIGTERM"); return; } catch { /* not a group leader */ }
	try { spawn("pkill", ["-TERM", "-P", String(pid)], { stdio: "ignore" }); } catch { /* pkill unavailable */ }
	try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
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
