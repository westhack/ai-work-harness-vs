/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { collectChangedNow, computeExternalChanges, takeExternalChangeSnapshot, type ChangeTrackingDeps, type GitResult } from "./changeTracking";

// Platform-agnostic fake absolute root (drive letter on Windows, "/repo" on posix).
const root = path.resolve(path.sep, "repo");
const buf = (text: string): Buffer => Buffer.from(text, "utf8");
const join = (...parts: string[]): string => path.join(root, ...parts);

/** In-memory git + fs: porcelain/diff/show come from mutable arrays and maps. */
interface FakeRepo {
	inRepo: boolean;
	files: Map<string, Buffer>;
	/** Tokens like " M a.txt" or "?? u.txt" returned by the *current* status call. */
	status: string[];
	/** Repo-relative paths returned by `git diff --name-only -z HEAD`. */
	diff: string[];
	/** HEAD blobs keyed by repo-relative forward-slash path. */
	head: Map<string, string>;
}

const makeRepo = (): FakeRepo => ({ inRepo: true, files: new Map(), status: [], diff: [], head: new Map() });

function makeDeps(repo: FakeRepo): ChangeTrackingDeps {
	const git = async (args: string[]): Promise<GitResult> => {
		const [cmd, ...rest] = args;
		if (cmd === "rev-parse") return repo.inRepo ? { code: 0, stdout: buf(`${root}\n`) } : { code: 128, stdout: buf("") };
		if (cmd === "status") return { code: 0, stdout: buf([...repo.status, ""].join("\0")) };
		if (cmd === "diff" && rest[0] === "--name-only") return { code: 0, stdout: buf([...repo.diff, ""].join("\0")) };
		if (cmd === "show") {
			const blob = repo.head.get(rest[0].slice("HEAD:".length));
			return blob === undefined ? { code: 128, stdout: buf("") } : { code: 0, stdout: buf(blob) };
		}
		return { code: 1, stdout: buf("") };
	};
	const readFile = async (file: string): Promise<Buffer> => {
		const data = repo.files.get(file);
		if (data === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
		return data;
	};
	return { git, readFile };
}

describe("takeExternalChangeSnapshot", () => {
	it("captures dirty tracked and untracked file contents", async () => {
		const repo = makeRepo();
		repo.status = [" M a.txt", "?? u.txt", " D gone.txt"];
		repo.files.set(join("a.txt"), buf("v1"));
		repo.files.set(join("u.txt"), buf("orig"));
		const snapshot = await takeExternalChangeSnapshot(root, makeDeps(repo));
		expect(snapshot!.repoRoot).toBe(root);
		expect(snapshot!.dirtyAtStart.get(join("a.txt"))).toEqual(buf("v1"));
		expect(snapshot!.dirtyAtStart.get(join("gone.txt"))).toBeNull(); // already deleted
		expect(snapshot!.untrackedAtStart.get(join("u.txt"))).toEqual(buf("orig"));
	});

	it("returns null outside a git repository", async () => {
		const repo = makeRepo();
		repo.inRepo = false;
		expect(await takeExternalChangeSnapshot(root, makeDeps(repo))).toBeNull();
	});
});

describe("collectChangedNow", () => {
	it("unions porcelain and diff entries inside the workspace root", async () => {
		const repo = makeRepo();
		repo.status = [" M a.txt", "?? new.txt"];
		repo.diff = ["a.txt", "del.txt"];
		const changed = await collectChangedNow(root, makeDeps(repo));
		expect(changed.sort()).toEqual([join("a.txt"), join("del.txt"), join("new.txt")].sort());
	});

	it("returns nothing outside a git repository", async () => {
		const repo = makeRepo();
		repo.inRepo = false;
		expect(await collectChangedNow(root, makeDeps(repo))).toEqual([]);
	});
});

describe("computeExternalChanges", () => {
	it("records an engine-created file in a clean repo with before=null", async () => {
		const repo = makeRepo();
		const snapshot = await takeExternalChangeSnapshot(root, makeDeps(repo));
		repo.files.set(join("new.txt"), buf("created"));
		repo.status = ["?? new.txt"];
		const changedNow = await collectChangedNow(root, makeDeps(repo));
		expect(await computeExternalChanges(root, snapshot!, [], changedNow, makeDeps(repo))).toEqual([
			{ path: join("new.txt"), before: null, after: buf("created"), existedBefore: false },
		]);
	});

	it("keeps the pre-run content of a dirty tracked file as before", async () => {
		const repo = makeRepo();
		repo.status = [" M a.txt"];
		repo.files.set(join("a.txt"), buf("v1"));
		const snapshot = await takeExternalChangeSnapshot(root, makeDeps(repo));
		repo.files.set(join("a.txt"), buf("v2")); // the engine edits it during the turn
		repo.status = [" M a.txt"];
		repo.diff = ["a.txt"];
		const changedNow = await collectChangedNow(root, makeDeps(repo));
		expect(await computeExternalChanges(root, snapshot!, [], changedNow, makeDeps(repo))).toEqual([
			{ path: join("a.txt"), before: buf("v1"), after: buf("v2"), existedBefore: true },
		]);
	});

	it("keeps the pre-run content of an untracked file the engine modified", async () => {
		const repo = makeRepo();
		repo.status = ["?? u.txt"];
		repo.files.set(join("u.txt"), buf("orig"));
		const snapshot = await takeExternalChangeSnapshot(root, makeDeps(repo));
		repo.files.set(join("u.txt"), buf("edited"));
		repo.status = ["?? u.txt"];
		repo.diff = [];
		const changedNow = await collectChangedNow(root, makeDeps(repo));
		expect(await computeExternalChanges(root, snapshot!, [], changedNow, makeDeps(repo))).toEqual([
			{ path: join("u.txt"), before: buf("orig"), after: buf("edited"), existedBefore: true },
		]);
	});

	it("uses the HEAD blob as before when the engine deletes a clean tracked file", async () => {
		const repo = makeRepo();
		repo.head.set("del.txt", "head-bytes");
		repo.files.set(join("del.txt"), buf("head-bytes"));
		const snapshot = await takeExternalChangeSnapshot(root, makeDeps(repo));
		repo.files.delete(join("del.txt"));
		repo.status = [" D del.txt"];
		repo.diff = ["del.txt"];
		const changedNow = await collectChangedNow(root, makeDeps(repo));
		expect(await computeExternalChanges(root, snapshot!, [], changedNow, makeDeps(repo))).toEqual([
			{ path: join("del.txt"), before: buf("head-bytes"), after: null, existedBefore: true },
		]);
	});

	it("filters by touchedPaths when non-empty and records everything when empty", async () => {
		const repo = makeRepo();
		repo.status = ["?? a.txt", "?? b.txt"];
		repo.files.set(join("a.txt"), buf("a1"));
		repo.files.set(join("b.txt"), buf("b1"));
		const snapshot = await takeExternalChangeSnapshot(root, makeDeps(repo));
		// The engine rewrites both files during the turn (identical bytes would be skipped as net-unchanged).
		repo.files.set(join("a.txt"), buf("a2"));
		repo.files.set(join("b.txt"), buf("b2"));
		const changedNow = [join("a.txt"), join("b.txt")];
		const deps = makeDeps(repo);
		const touched = await computeExternalChanges(root, snapshot!, [join("a.txt")], changedNow, deps);
		expect(touched.map((record) => record.path)).toEqual([join("a.txt")]);
		const all = await computeExternalChanges(root, snapshot!, [], changedNow, deps);
		expect(all.map((record) => record.path)).toEqual([join("a.txt"), join("b.txt")]);
	});

	it("skips files whose net content is unchanged", async () => {
		const repo = makeRepo();
		repo.status = [" M s.txt"];
		repo.files.set(join("s.txt"), buf("same"));
		const snapshot = await takeExternalChangeSnapshot(root, makeDeps(repo));
		// The engine rewrote identical bytes.
		repo.status = [" M s.txt"];
		repo.diff = ["s.txt"];
		expect(await computeExternalChanges(root, snapshot!, [], [join("s.txt")], makeDeps(repo))).toEqual([]);
	});

	it("does not report a file that was already deleted before the run and is still missing", async () => {
		const repo = makeRepo();
		repo.status = [" D gone.txt"];
		const snapshot = await takeExternalChangeSnapshot(root, makeDeps(repo));
		repo.status = [" D gone.txt"];
		repo.diff = ["gone.txt"];
		expect(await computeExternalChanges(root, snapshot!, [], [join("gone.txt")], makeDeps(repo))).toEqual([]);
	});

	it("records a file deleted before the run but recreated with new content by the engine", async () => {
		const repo = makeRepo();
		repo.status = [" D back.txt"];
		const snapshot = await takeExternalChangeSnapshot(root, makeDeps(repo));
		repo.files.set(join("back.txt"), buf("reborn"));
		repo.status = [" M back.txt"];
		repo.diff = ["back.txt"];
		expect(await computeExternalChanges(root, snapshot!, [], [join("back.txt")], makeDeps(repo))).toEqual([
			{ path: join("back.txt"), before: null, after: buf("reborn"), existedBefore: false },
		]);
	});

	it("skips files whose pre-run content was unreadable", async () => {
		const repo = makeRepo();
		repo.status = [" M a.txt"];
		repo.files.set(join("a.txt"), buf("v1"));
		const failing: ChangeTrackingDeps = {
			git: async () => ({ code: 0, stdout: buf("") }),
			readFile: async (file: string) => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
		};
		const snapshot = await takeExternalChangeSnapshot(root, { git: makeDeps(repo).git, readFile: failing.readFile });
		expect(snapshot!.unreadableAtStart.has(join("a.txt"))).toBe(true);
		repo.status = [" M a.txt"];
		repo.diff = ["a.txt"];
		repo.files.set(join("a.txt"), buf("v2"));
		expect(await computeExternalChanges(root, snapshot!, [], [join("a.txt")], makeDeps(repo))).toEqual([]);
	});
});
