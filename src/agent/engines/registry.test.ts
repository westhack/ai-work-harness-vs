/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: fixture.execFile }));

import { describeEngineBinary, getLocalEnginesRoot, resolveEngineBinary, setEngineOverrides, setLocalEnginesRoot } from "./registry";

let root: string;

beforeEach(() => {
	vi.clearAllMocks();
	// Nothing is on PATH: `where`/`which` rejects like a missing command.
	fixture.execFile.mockImplementation((_file: string, _args: string[], _options: object, callback: (error: Error) => void) => {
		callback(new Error("not found"));
	});
	setLocalEnginesRoot(undefined);
	setEngineOverrides(undefined);
	root = mkdtempSync(join(tmpdir(), "aiworkharness-engines-"));
});

afterEach(() => {
	setLocalEnginesRoot(undefined);
	setEngineOverrides(undefined);
	rmSync(root, { recursive: true, force: true });
});

/** Create a real (empty) CLI inside the extension-owned engines folder. */
function localBinary(id: string, command: string): string {
	const dir = join(root, id, "node_modules", ".bin");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, process.platform === "win32" ? `${command}.cmd` : command);
	writeFileSync(file, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
	return file;
}

describe("engine binary resolution", () => {
	it("prefers the extension folder over PATH", async () => {
		const local = localBinary("dsh", "dsh");
		setLocalEnginesRoot(root);
		await expect(describeEngineBinary("dsh")).resolves.toEqual({ path: local, source: "extension" });
		expect(fixture.execFile).not.toHaveBeenCalled();
	});

	it("prefers a user-picked override over the extension folder", async () => {
		const local = localBinary("dsh", "dsh");
		const picked = join(root, "my-dsh");
		writeFileSync(picked, "");
		setLocalEnginesRoot(root);
		setEngineOverrides({ dsh: picked });
		await expect(describeEngineBinary("dsh")).resolves.toEqual({ path: picked, source: "override" });
		expect(local).not.toBe(picked);
	});

	it("does not answer from a stale cache after the override changes", async () => {
		const first = join(root, "first");
		const second = join(root, "second");
		writeFileSync(first, "");
		writeFileSync(second, "");
		setEngineOverrides({ dsh: first });
		await expect(describeEngineBinary("dsh")).resolves.toMatchObject({ path: first });
		// Same call again is cached under the same key.
		await expect(describeEngineBinary("dsh")).resolves.toMatchObject({ path: first });
		setEngineOverrides({ dsh: second });
		await expect(describeEngineBinary("dsh")).resolves.toMatchObject({ path: second });
		// The explicit override is part of the key, so it never reuses the above.
		await expect(describeEngineBinary("dsh", first)).resolves.toMatchObject({ path: first });
	});

	it("keeps resolveEngineBinary returning the plain path", async () => {
		const picked = join(root, "picked");
		writeFileSync(picked, "");
		setEngineOverrides({ dsh: picked });
		await expect(resolveEngineBinary("dsh")).resolves.toBe(picked);
	});

	it("returns undefined when no source is available", async () => {
		await expect(describeEngineBinary("dsh")).resolves.toBeUndefined();
		await expect(describeEngineBinary("builtin")).resolves.toBeUndefined();
		expect(getLocalEnginesRoot()).toBeUndefined();
	});
});
