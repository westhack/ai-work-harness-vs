/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { describe, expect, it, vi } from "vitest";
import * as nodePath from "node:path";
import { compressHistory, runExternalEngine } from "./dispatch";
import { getEngine } from "./registry";
import { takeExternalChangeSnapshot } from "./changeTracking";
import type { Step } from "../types";

// Change tracking is faked so the dispatch integration below never spawns git.
const tracked = vi.hoisted(() => ({ touchedPaths: [] as string[] }));
vi.mock("./changeTracking", () => ({
	takeExternalChangeSnapshot: vi.fn(async () => ({
		repoRoot: nodePath.resolve(nodePath.sep, "ws"),
		dirtyAtStart: new Map(),
		untrackedAtStart: new Map(),
		unreadableAtStart: new Set<string>(),
	})),
	collectChangedNow: vi.fn(async () => [
		nodePath.resolve(nodePath.sep, "ws", "a.txt"),
		nodePath.resolve(nodePath.sep, "ws", "b.txt"),
	]),
	computeExternalChanges: vi.fn(async (_root: string, _snapshot: unknown, touchedPaths: string[], changedNow: string[]) => {
		tracked.touchedPaths = touchedPaths;
		return changedNow.map((file) => ({ path: file, before: null, after: Buffer.from("after"), existedBefore: false }));
	}),
}));

const user = (text: string): Step => ({ kind: "user", text });
const assistant = (text: string): Step => ({ kind: "assistant", text, calls: [] });
const toolResult = (callId: string): Step => ({ kind: "tool-result", callId, name: "Shell", output: "out", status: "completed" });

describe("compressHistory", () => {
	it("keeps user/assistant text and drops synthetic and tool steps", () => {
		const history: Step[] = [
			user("First request"),
			assistant("Working on it"),
			toolResult("call_1"),
			{ kind: "user", synthetic: true, text: "loop nudge" },
			user("Follow-up"),
		];
		expect(compressHistory(history)).toEqual([
			{ role: "user", text: "First request" },
			{ role: "assistant", text: "Working on it" },
			{ role: "user", text: "Follow-up" },
		]);
	});

	it("clips to the most recent 20 messages", () => {
		const history: Step[] = Array.from({ length: 30 }, (_, i) => user(`msg ${i}`));
		const compressed = compressHistory(history);
		expect(compressed).toHaveLength(20);
		expect(compressed[0]).toEqual({ role: "user", text: "msg 10" });
		expect(compressed.at(-1)).toEqual({ role: "user", text: "msg 29" });
	});

	it("truncates oversized messages to 8k characters", () => {
		const history: Step[] = [user("x".repeat(9_000)), assistant("short")];
		const compressed = compressHistory(history);
		expect(compressed[0].text).toHaveLength(8_001); // 8000 chars + ellipsis
		expect(compressed[0].text.endsWith("…")).toBe(true);
		expect(compressed[1]).toEqual({ role: "assistant", text: "short" });
	});
});

describe("runExternalEngine", () => {
	const baseRun = {
		workspaceRoot: "H:/ws",
		prompt: "hello",
		history: [user("hi")] as Step[],
		mode: "agent",
		runId: "run_1",
		signal: new AbortController().signal,
		drainSteering: async () => [],
		approve: async () => true,
	};

	it("rejects unknown engines without emitting", async () => {
		const emit = vi.fn();
		await expect(runExternalEngine("nope" as never, { ...baseRun, emit: emit as never })).rejects.toThrow("Unknown agent engine: nope");
		expect(emit).not.toHaveBeenCalled();
	});

	it("emits running, then finished when the adapter succeeds", async () => {
		const emit = vi.fn();
		const engine = getEngine("builtin")!;
		const runSpy = vi.spyOn(engine, "run").mockResolvedValue({ text: "done", sessionId: "s1" });
		await runExternalEngine("builtin", { ...baseRun, emit });
		expect(emit.mock.calls.map((call) => call[0])).toEqual([
			{ type: "run-status", status: "running" },
			{ type: "run-status", status: "finished" },
		]);
		runSpy.mockRestore();
	});

	it("reports failures through the caller (no duplicate error emit)", async () => {
		const emit = vi.fn();
		const engine = getEngine("builtin")!;
		const runSpy = vi.spyOn(engine, "run").mockRejectedValue(new Error("adapter exploded"));
		await expect(runExternalEngine("builtin", { ...baseRun, emit })).rejects.toThrow("adapter exploded");
		expect(emit).toHaveBeenCalledTimes(1); // only run-status running
		runSpy.mockRestore();
	});
});

describe("runExternalEngine change tracking", () => {
	const root = nodePath.resolve(nodePath.sep, "ws");
	const trackedRun = {
		workspaceRoot: root,
		conversationId: "conv1",
		prompt: "hello",
		history: [] as Step[],
		mode: "agent",
		runId: "run_1",
		signal: new AbortController().signal,
		approve: async () => true,
		drainSteering: async () => [],
	};

	it("collects file paths from tool-call-started inputs and registers the computed changes", async () => {
		const emit = vi.fn();
		const registerChanges = vi.fn(async (_owner: unknown, _records: unknown[]) => {});
		const engine = getEngine("builtin")!;
		const runSpy = vi.spyOn(engine, "run").mockImplementation(async (rt) => {
			rt.emit({ type: "tool-call-started", callId: "c1", name: "Write", input: { file_path: nodePath.join(root, "a.txt") } });
			rt.emit({ type: "tool-call-started", callId: "c2", name: "Edit", input: { file_path: "b.txt" } });
			rt.emit({ type: "tool-call-started", callId: "c3", name: "Shell", input: { command: "ls" } });
			rt.emit({ type: "tool-call-started", callId: "c4", name: "Read", input: { file_path: nodePath.resolve(root, "..", "outside.txt") } });
			await rt.approve("edit_file", { path: nodePath.join(root, "b.txt") });
			return { text: "done" };
		});
		await runExternalEngine("builtin", { ...trackedRun, emit: emit as never, registerChanges });
		// Touched = both named files (relative resolved, outside ignored); approve re-naming b.txt adds nothing new.
		expect(tracked.touchedPaths).toEqual([nodePath.join(root, "a.txt"), nodePath.join(root, "b.txt")]);
		expect(registerChanges).toHaveBeenCalledTimes(1);
		expect(registerChanges.mock.calls[0][0]).toEqual({ conversationId: "conv1", runId: "run_1" });
		expect(registerChanges.mock.calls[0][1]).toHaveLength(2);
		runSpy.mockRestore();
	});

	it("registers changes even when the adapter fails", async () => {
		const emit = vi.fn();
		const registerChanges = vi.fn(async () => {});
		const engine = getEngine("builtin")!;
		const runSpy = vi.spyOn(engine, "run").mockRejectedValue(new Error("adapter exploded"));
		await expect(runExternalEngine("builtin", { ...trackedRun, emit: emit as never, registerChanges })).rejects.toThrow("adapter exploded");
		expect(registerChanges).toHaveBeenCalledTimes(1);
		runSpy.mockRestore();
	});

	it("takes no snapshot when no registerChanges hook is provided", async () => {
		const emit = vi.fn();
		const engine = getEngine("builtin")!;
		const runSpy = vi.spyOn(engine, "run").mockResolvedValue({ text: "done" });
		vi.mocked(takeExternalChangeSnapshot).mockClear();
		await runExternalEngine("builtin", { ...trackedRun, emit: emit as never });
		expect(takeExternalChangeSnapshot).not.toHaveBeenCalled();
		runSpy.mockRestore();
	});
});
