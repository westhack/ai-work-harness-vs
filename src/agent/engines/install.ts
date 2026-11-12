/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineId } from "./types";
import { clearEngineCaches, getLocalEnginesRoot, killProcessTree, resolveEngineBinary, spawnCommand, whereBinary } from "./registry";

/** How to obtain one external engine. Engines without `npm` need a manual install. */
export type EngineInstallSpec = {
	npm?: string;
	extraArgs?: string[];
	docsUrl?: string;
	manualNote?: string;
};

/** Verified npm package names (or manual-install notes) per external engine. */
export const ENGINE_INSTALL_SPECS: Record<Exclude<EngineId, "builtin">, EngineInstallSpec> = {
	"claude-code": { npm: "@anthropic-ai/claude-code", docsUrl: "https://docs.anthropic.com/en/docs/claude-code" },
	opencode: { npm: "opencode-ai", docsUrl: "https://opencode.ai/docs/" },
	dsh: { npm: "@deepseek-ai/dsh", docsUrl: "https://github.com/deepseek-ai/deepseek-harness" },
	gemini: { npm: "@google/gemini-cli", docsUrl: "https://github.com/google-gemini/gemini-cli" },
	qwen: { npm: "@qwen-code/qwen-code", docsUrl: "https://github.com/QwenLM/qwen-code" },
	kimi: { npm: "@moonshot-ai/kimi-code", docsUrl: "https://github.com/MoonshotAI/kimi-cli" },
	crush: { npm: "@charmland/crush", docsUrl: "https://github.com/charmbracelet/crush" },
	zcode: { manualNote: "ZCode ships as a native binary from its official distribution." },
	pi: { npm: "@earendil-works/pi-coding-agent", extraArgs: ["--ignore-scripts"], docsUrl: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent" },
	codex: { npm: "@openai/codex", docsUrl: "https://github.com/openai/codex" },
};

/** Upper bound for one npm install, matching the settings UI's spinner. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/** Only the tail of a failed install is useful for diagnostics. */
const DETAIL_LINES = 20;

const installs = new Map<string, Promise<EngineInstallResult>>();

/** Where npm put the package: the extension folder or the global prefix. */
export type EngineInstallScope = "extension" | "global";

export type EngineInstallResult = {
	ok: boolean;
	detail?: string;
	binaryPath?: string;
	scope: EngineInstallScope;
};

/** The command shown in the settings UI, e.g. `npm install -g @openai/codex`. */
export function engineInstallCommand(id: EngineId): string | undefined {
	if (id === "builtin") return undefined;
	const spec = ENGINE_INSTALL_SPECS[id];
	if (!spec.npm) return undefined;
	return ["npm", "install", "-g", ...(spec.extraArgs ?? []), spec.npm].join(" ");
}

/** Resolve the npm shim; Windows runs the `.cmd` variant through ComSpec. */
async function resolveNpmBinary(): Promise<string> {
	const located = await whereBinary("npm");
	if (located) return located;
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

/** Split stream chunks into complete lines, treating `\r` progress bars as breaks. */
function lineWriter(onLine: (line: string) => void) {
	let buffered = "";
	return {
		push(chunk: string) {
			buffered += chunk;
			const lines = buffered.split(/\r\n|\n|\r/);
			buffered = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) onLine(line);
		},
		flush() {
			const line = buffered;
			buffered = "";
			if (line.trim()) onLine(line);
		},
	};
}

/**
 * Run one npm install with streamed output. Arguments are passed as an array so
 * no shell quoting is involved; the process runs in the temp directory so no
 * package.json or node_modules ever lands in the workspace.
 */
export function runNpmInstall(
	binary: string,
	args: string[],
	onLine: (line: string) => void,
	timeoutMs: number = INSTALL_TIMEOUT_MS,
): Promise<{ ok: boolean; detail?: string }> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const tail: string[] = [];
		const record = (line: string) => {
			tail.push(line);
			if (tail.length > DETAIL_LINES) tail.shift();
			onLine(line);
		};
		const out = lineWriter(record);
		const err = lineWriter(record);
		const finish = (result: { ok: boolean; detail?: string }) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(result);
		};

		let child: ChildProcess;
		try {
			child = spawnCommand(binary, args, { cwd: tmpdir() });
		} catch (error) {
			finish({ ok: false, detail: String((error as Error)?.message || error) });
			return;
		}

		timer = setTimeout(() => {
			killProcessTree(child.pid);
			finish({ ok: false, detail: "install timed out" });
		}, timeoutMs);

		child.stdout?.on("data", (chunk) => out.push(String(chunk)));
		child.stderr?.on("data", (chunk) => err.push(String(chunk)));
		child.on("error", (error: Error) => {
			const code = (error as NodeJS.ErrnoException).code;
			finish({
				ok: false,
				detail: code === "ENOENT" ? "npm was not found — install Node.js first" : String(error.message || error),
			});
		});
		child.on("close", (code) => {
			out.flush();
			err.flush();
			if (code === 0) {
				finish({ ok: true });
				return;
			}
			const detail = `npm exited with code ${code ?? "unknown"}\n${tail.join("\n")}`.trim();
			finish({ ok: false, detail });
		});
	});
}

/**
 * Install one engine: into the extension folder when a local root is configured
 * (no global npm pollution), otherwise into the global npm prefix.
 */
async function runEngineInstall(id: Exclude<EngineId, "builtin">, onLine: (line: string) => void): Promise<EngineInstallResult> {
	const spec = ENGINE_INSTALL_SPECS[id];
	if (!spec.npm) return { ok: false, scope: "global", detail: "This engine has no npm package — install it manually." };
	const npm = await resolveNpmBinary();
	const root = getLocalEnginesRoot();
	const scope: EngineInstallScope = root ? "extension" : "global";
	const extraArgs = spec.extraArgs ?? [];
	let args: string[];
	if (root) {
		const prefix = join(root, id);
		await mkdir(prefix, { recursive: true });
		args = ["install", "--prefix", prefix, "--no-audit", "--no-fund", ...extraArgs, spec.npm];
	} else {
		args = ["install", "-g", ...extraArgs, spec.npm];
	}
	const result = await runNpmInstall(npm, args, onLine);
	if (!result.ok) return { ...result, scope };
	clearEngineCaches(id);
	const binaryPath = await resolveEngineBinary(id);
	return binaryPath
		? { ok: true, binaryPath, scope }
		: { ok: true, scope, detail: "Installed but the executable could not be resolved." };
}

/**
 * Install one engine. Repeated calls for the same engine share one process, so
 * double-clicks stream the same run instead of spawning twice.
 */
export function installEngine(id: EngineId, onLine: (line: string) => void): Promise<EngineInstallResult> {
	if (id === "builtin") return Promise.resolve({ ok: false, scope: "global", detail: "The built-in engine does not need installation." });
	const running = installs.get(id);
	if (running) return running;
	const task = runEngineInstall(id, onLine).finally(() => installs.delete(id));
	installs.set(id, task);
	return task;
}
