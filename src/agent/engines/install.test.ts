/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	spawnCommand: vi.fn(),
	killProcessTree: vi.fn(),
	clearEngineCaches: vi.fn(),
	resolveEngineBinary: vi.fn(),
	describeEngineBinary: vi.fn(),
	whereBinary: vi.fn(),
	getLocalEnginesRoot: vi.fn(),
	engineInstallDirectory: vi.fn(),
	getEngineOverride: vi.fn(),
}));

vi.mock("./registry", () => fixture);

import { engineInstallCommand, installEngine, runNpmInstall, uninstallEngine } from "./install";

class FakeChild extends EventEmitter {
	pid = 4242;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
}

/** Spawn a fake child that emits the given output and then closes. */
function spawnWith(child: FakeChild, close: () => void) {
	fixture.spawnCommand.mockImplementation(() => {
		setTimeout(close, 0);
		return child;
	});
	return child;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.clearAllMocks();
	fixture.whereBinary.mockResolvedValue("/usr/local/bin/npm");
	fixture.resolveEngineBinary.mockResolvedValue("/usr/local/bin/engine");
	fixture.describeEngineBinary.mockResolvedValue({ path: "/usr/local/bin/engine", source: "path" });
	fixture.clearEngineCaches.mockReset();
	fixture.getLocalEnginesRoot.mockReturnValue(undefined);
	fixture.getEngineOverride.mockReturnValue(undefined);
	fixture.engineInstallDirectory.mockImplementation((id: string) => {
		const root = fixture.getLocalEnginesRoot();
		return root ? join(root, id) : undefined;
	});
});

describe("engineInstallCommand", () => {
	it("builds npm commands and skips engines without a package", () => {
		expect(engineInstallCommand("codex")).toBe("npm install -g @openai/codex");
		expect(engineInstallCommand("pi")).toBe("npm install -g --ignore-scripts @earendil-works/pi-coding-agent");
		expect(engineInstallCommand("dsh")).toBe("npm install -g @deepseek-ai/dsh");
		expect(engineInstallCommand("zcode")).toBeUndefined();
		expect(engineInstallCommand("builtin")).toBeUndefined();
	});
});

describe("runNpmInstall", () => {
	it("reports a missing npm as a Node.js prerequisite", async () => {
		fixture.whereBinary.mockResolvedValue(undefined);
		const child = new FakeChild();
		fixture.spawnCommand.mockImplementation(() => {
			setTimeout(() => child.emit("error", Object.assign(new Error("spawn npm.cmd ENOENT"), { code: "ENOENT" })), 0);
			return child;
		});
		const result = await installEngine("codex", () => {});
		expect(result.ok).toBe(false);
		expect(result.detail).toMatch(/Node\.js/);
		expect(fixture.whereBinary).toHaveBeenCalledWith("npm");
	});

	it("streams lines and resolves ok on exit 0", async () => {
		const child = new FakeChild();
		spawnWith(child, () => {
			child.stdout.emit("data", "downloading 10%\rdownloading 50%\nadded 1 package\n");
			child.emit("close", 0);
		});
		const lines: string[] = [];
		const result = await installEngine("codex", (line) => lines.push(line));
		expect(result).toEqual({ ok: true, binaryPath: "/usr/local/bin/engine", scope: "global" });
		expect(lines).toEqual(["downloading 10%", "downloading 50%", "added 1 package"]);
		expect(fixture.spawnCommand).toHaveBeenCalledWith("/usr/local/bin/npm",
			["install", "-g", "@openai/codex"], { cwd: expect.any(String) });
		expect(fixture.clearEngineCaches).toHaveBeenCalledWith("codex");
		expect(fixture.resolveEngineBinary).toHaveBeenCalledWith("codex");
	});

	it("keeps ok when the new bin folder is not on PATH yet", async () => {
		fixture.resolveEngineBinary.mockResolvedValue(undefined);
		const child = new FakeChild();
		spawnWith(child, () => child.emit("close", 0));
		const result = await installEngine("qwen", () => {});
		expect(result.ok).toBe(true);
		expect(result.binaryPath).toBeUndefined();
		expect(result.scope).toBe("global");
		expect(result.detail).toContain("could not be resolved");
	});

	it("includes only the last 20 output lines when npm fails", async () => {
		const child = new FakeChild();
		const output = Array.from({ length: 30 }, (_, index) => `line-${index}`).join("\n");
		spawnWith(child, () => {
			child.stderr.emit("data", output + "\n");
			child.emit("close", 1);
		});
		const result = await installEngine("gemini", () => {});
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("npm exited with code 1");
		expect(result.detail).toContain("line-29");
		expect(result.detail).not.toContain("line-0");
	});

	it("kills the process tree and reports a timeout", async () => {
		const child = new FakeChild();
		fixture.spawnCommand.mockReturnValue(child);
		const result = await runNpmInstall("npm", ["install", "-g", "x"], () => {}, 20);
		expect(result).toEqual({ ok: false, detail: "install timed out" });
		expect(fixture.killProcessTree).toHaveBeenCalledWith(4242);
	});
});

describe("installEngine", () => {
	it("installs into the extension folder when a local root is configured", async () => {
		const root = mkdtempSync(join(tmpdir(), "aiworkharness-engines-"));
		try {
			fixture.getLocalEnginesRoot.mockReturnValue(root);
			const child = new FakeChild();
			spawnWith(child, () => child.emit("close", 0));
			const result = await installEngine("codex", () => {});
			expect(fixture.spawnCommand.mock.calls[0][1]).toEqual([
				"install", "--prefix", join(root, "codex"), "--no-audit", "--no-fund", "@openai/codex",
			]);
			expect(result).toEqual({ ok: true, binaryPath: "/usr/local/bin/engine", scope: "extension" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("puts extra args before the package name (pi needs --ignore-scripts)", async () => {
		const child = new FakeChild();
		spawnWith(child, () => child.emit("close", 0));
		await installEngine("pi", () => {});
		expect(fixture.spawnCommand.mock.calls[0][1]).toEqual(
			["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"]);
	});

	it("shares one process between concurrent installs of the same engine", async () => {
		const child = new FakeChild();
		spawnWith(child, () => child.emit("close", 0));
		const first = installEngine("crush", () => {});
		const second = installEngine("crush", () => {});
		await tick();
		expect(fixture.spawnCommand).toHaveBeenCalledTimes(1);
		const [a, b] = await Promise.all([first, second]);
		expect(a).toEqual(b);
		expect(a.ok).toBe(true);
	});
});

describe("uninstallEngine", () => {
	it("deletes the extension install folder and clears the caches", async () => {
		const root = mkdtempSync(join(tmpdir(), "aiworkharness-engines-"));
		try {
			fixture.getLocalEnginesRoot.mockReturnValue(root);
			const dir = join(root, "codex");
			mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
			writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "x".repeat(1024));
			fixture.describeEngineBinary.mockResolvedValue({ path: join(dir, "bin", "codex"), source: "extension" });
			const lines: string[] = [];
			const result = await uninstallEngine("codex", (line) => lines.push(line));
			expect(result.ok).toBe(true);
			expect(result.freedBytes).toBeGreaterThan(0);
			expect(existsSync(dir)).toBe(false);
			expect(fixture.clearEngineCaches).toHaveBeenCalledWith("codex");
			expect(lines.join("\n")).toContain(dir);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses when the user picked a custom binary path", async () => {
		fixture.getEngineOverride.mockReturnValue("C:/tools/codex.exe");
		const result = await uninstallEngine("codex", () => {});
		expect(result.ok).toBe(false);
		expect(result.detail).toMatch(/path you selected/);
		expect(fixture.clearEngineCaches).not.toHaveBeenCalled();
	});

	it("refuses global installs", async () => {
		const result = await uninstallEngine("codex", () => {});
		expect(result.ok).toBe(false);
		expect(result.detail).toMatch(/globally/);
	});

	it("refuses when nothing was installed into the extension folder", async () => {
		const root = mkdtempSync(join(tmpdir(), "aiworkharness-engines-"));
		try {
			fixture.getLocalEnginesRoot.mockReturnValue(root);
			const result = await uninstallEngine("qwen", () => {});
			expect(result.ok).toBe(false);
			expect(result.detail).toMatch(/Nothing is installed/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the folder when another copy is the active binary", async () => {
		const root = mkdtempSync(join(tmpdir(), "aiworkharness-engines-"));
		try {
			fixture.getLocalEnginesRoot.mockReturnValue(root);
			const dir = join(root, "gemini");
			mkdirSync(dir, { recursive: true });
			fixture.describeEngineBinary.mockResolvedValue({ path: "/usr/local/bin/gemini", source: "path" });
			const result = await uninstallEngine("gemini", () => {});
			expect(result.ok).toBe(false);
			expect(result.detail).toMatch(/not the extension copy/);
			expect(existsSync(dir)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("never uninstalls the built-in engine", async () => {
		const result = await uninstallEngine("builtin", () => {});
		expect(result.ok).toBe(false);
		expect(result.detail).toMatch(/built-in/);
	});
});
