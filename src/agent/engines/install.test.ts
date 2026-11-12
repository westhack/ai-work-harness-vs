/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	spawnCommand: vi.fn(),
	killProcessTree: vi.fn(),
	clearEngineCaches: vi.fn(),
	resolveEngineBinary: vi.fn(),
	whereBinary: vi.fn(),
	getLocalEnginesRoot: vi.fn(),
}));

vi.mock("./registry", () => fixture);

import { engineInstallCommand, installEngine, runNpmInstall } from "./install";

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
	fixture.clearEngineCaches.mockReset();
	fixture.getLocalEnginesRoot.mockReturnValue(undefined);
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
