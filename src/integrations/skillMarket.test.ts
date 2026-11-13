/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => state.home };
});

import { installMarketSkill, listMarketSkills, marketSkillDetail, pickSkillDirectory, searchMarketSkills, type MarketSkill } from "./skillMarket";

const fetchMock = vi.fn();

function jsonResponse(body: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => body,
		arrayBuffer: async () => new ArrayBuffer(0),
	} as unknown as Response;
}

function bytesResponse(text: string): Response {
	const data = new TextEncoder().encode(text);
	return {
		ok: true,
		status: 200,
		json: async () => ({}),
		arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
	} as unknown as Response;
}

function textResponse(html: string): Response {
	return {
		ok: true,
		status: 200,
		json: async () => ({}),
		text: async () => html,
		arrayBuffer: async () => new ArrayBuffer(0),
	} as unknown as Response;
}

function skillsShSkill(overrides: Partial<MarketSkill> = {}): MarketSkill {
	return {
		id: "vercel-labs/agent-skills/demo",
		source: "skills.sh",
		name: "demo",
		pageUrl: "https://skills.sh/vercel-labs/agent-skills/demo",
		repo: "vercel-labs/agent-skills",
		skill: "demo",
		installable: true,
		...overrides,
	};
}

beforeEach(() => {
	state.home = mkdtempSync(join(tmpdir(), "awh-market-"));
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(state.home, { recursive: true, force: true });
});

describe("searchMarketSkills", () => {
	it("maps skills.sh search hits", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({
			skills: [{ id: "a/b/c", source: "a/b", skillId: "c", name: "c", installs: 42 }],
		}));
		const results = await searchMarketSkills("skills.sh", " c ");
		expect(fetchMock.mock.calls[0][0]).toBe("https://skills.sh/api/search?q=c");
		expect(results.results).toHaveLength(1);
		expect(results.results[0]).toMatchObject({
			id: "a/b/c",
			source: "skills.sh",
			repo: "a/b",
			skill: "c",
			installs: 42,
			installable: true,
			pageUrl: "https://skills.sh/a/b/c",
		});
	});

	it("marks site-hosted skills.sh entries as manual", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({
			skills: [{ source: "site/open.feishu.cn", skillId: "lark-doc", name: "lark-doc" }],
		}));
		const [entry] = (await searchMarketSkills("skills.sh", "lark")).results;
		expect(entry.installable).toBe(false);
	});

	it("maps SkillHub entries with Chinese descriptions", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({
			data: {
				skills: [{
					name: "设计助手",
					slug: "design-helper",
					description: "Design helper",
					description_zh: "设计助手",
					downloads: 71000,
					version: "0.1.0",
					namespace: { handle: "clawhub_x", publicSlug: "design-helper" },
				}],
			},
		}));
		const [entry] = (await searchMarketSkills("skillhub.cn", "设计")).results;
		expect(String(fetchMock.mock.calls[0][0])).toContain("api.skillhub.cn/api/skills?");
		expect(entry).toMatchObject({
			source: "skillhub.cn",
			name: "设计助手",
			description: "设计助手",
			installs: 71000,
			slug: "design-helper",
			namespace: "clawhub_x",
			installable: true,
		});
	});

	it("returns nothing for an empty query", async () => {
		expect((await searchMarketSkills("skills.sh", "   ")).results).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("listMarketSkills", () => {
	it("parses the skills.sh leaderboard links", async () => {
		fetchMock.mockResolvedValueOnce(textResponse([
			'<a href="/vercel-labs/skills/find-skills">x</a>',
			'<a href="/vercel-labs/skills/find-skills">x</a>',
			'<a href="/site/open.feishu.cn/lark-doc">x</a>',
			'<a href="/trending">x</a>',
		].join("")));
		const results = await listMarketSkills("skills.sh", 1, 10);
		expect(results.results).toHaveLength(1);
		expect(results.hasMore).toBe(false);
		expect(results.results[0]).toMatchObject({
			source: "skills.sh",
			repo: "vercel-labs/skills",
			skill: "find-skills",
			pageUrl: "https://skills.sh/vercel-labs/skills/find-skills",
			installable: true,
		});
	});

	it("loads the SkillHub download ranking without a keyword", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({
			data: { skills: [{ name: "热门", slug: "hot", namespace: { handle: "ns" } }] },
		}));
		const [entry] = (await listMarketSkills("skillhub.cn", 1, 10)).results;
		expect(String(fetchMock.mock.calls[0][0])).toContain("sortBy=downloads");
		expect(String(fetchMock.mock.calls[0][0])).not.toContain("keyword=");
		expect(entry.slug).toBe("hot");
	});

	it("pages through SkillHub with its total count", async () => {
		const rows = Array.from({ length: 10 }, (_, index) => ({ name: `s${index}`, slug: `s${index}`, namespace: { handle: "ns" } }));
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { skills: rows, total: 227353 } }));
		const page1 = await listMarketSkills("skillhub.cn", 1, 10);
		expect(page1.total).toBe(227353);
		expect(page1.hasMore).toBe(true);
		expect(String(fetchMock.mock.calls[0][0])).toContain("page=1");
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { skills: rows, total: 227353 } }));
		await listMarketSkills("skillhub.cn", 2, 10);
		expect(String(fetchMock.mock.calls[1][0])).toContain("page=2");
	});

	it("switches to trending ranking", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ data: { skills: [] } }))
			.mockResolvedValueOnce(textResponse('<a href="/a/b/c">x</a>'));
		await listMarketSkills("skillhub.cn", 1, 10, "trending");
		expect(String(fetchMock.mock.calls[0][0])).toContain("sortBy=trending");
		await listMarketSkills("skills.sh", 1, 10, "trending");
		expect(fetchMock.mock.calls[1][0]).toBe("https://skills.sh/trending");
	});
});

describe("installMarketSkill", () => {
	it("downloads a GitHub-hosted skill folder", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({
				tree: [
					{ path: "skills/demo/SKILL.md", type: "blob" },
					{ path: "skills/demo/reference.md", type: "blob" },
					{ path: "skills/other/SKILL.md", type: "blob" },
				],
			}))
			.mockResolvedValueOnce(bytesResponse("---\nname: demo\n---\nhello"))
			.mockResolvedValueOnce(bytesResponse("ref"));
		const result = await installMarketSkill(skillsShSkill());
		expect(result.ok).toBe(true);
		const dir = join(state.home, ".aiworkharness", "skills", "demo");
		expect(result.path).toBe(dir);
		expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("hello");
		expect(readFileSync(join(dir, "reference.md"), "utf8")).toBe("ref");
		expect(existsSync(join(dir, "other"))).toBe(false);
	});

	it("downloads a SkillHub skill through its file endpoints", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ files: [{ path: "SKILL.md" }, { path: "scripts/run.py" }] }))
			.mockResolvedValueOnce(bytesResponse("---\nname: hub\n---"))
			.mockResolvedValueOnce(bytesResponse("print(1)"));
		const result = await installMarketSkill({
			id: "ns/hub-skill",
			source: "skillhub.cn",
			name: "中文技能",
			pageUrl: "https://skillhub.cn/skills?keyword=hub",
			slug: "hub-skill",
			namespace: "ns",
			installable: true,
		});
		expect(result.ok).toBe(true);
		const dir = join(state.home, ".aiworkharness", "skills", "hub-skill");
		expect(readFileSync(join(dir, "scripts", "run.py"), "utf8")).toBe("print(1)");
	});

	it("refuses to overwrite an installed skill", async () => {
		mkdirSync(join(state.home, ".aiworkharness", "skills", "demo"), { recursive: true });
		const result = await installMarketSkill(skillsShSkill());
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("Already installed");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects unsafe paths and cleans up the partial download", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ files: [{ path: "SKILL.md" }, { path: "../escape.md" }] }))
			.mockResolvedValueOnce(bytesResponse("ok"));
		const result = await installMarketSkill({
			id: "ns/evil",
			source: "skillhub.cn",
			name: "evil",
			pageUrl: "https://skillhub.cn/skills?keyword=evil",
			slug: "evil",
			namespace: "ns",
			installable: true,
		});
		expect(result.ok).toBe(false);
		expect(result.detail).toMatch(/unsafe path/i);
		expect(existsSync(join(state.home, ".aiworkharness", "skills", "evil"))).toBe(false);
		expect(existsSync(join(state.home, ".aiworkharness", "escape.md"))).toBe(false);
	});

	it("refuses non-installable entries", async () => {
		const result = await installMarketSkill(skillsShSkill({ installable: false }));
		expect(result.ok).toBe(false);
	});
});

describe("marketSkillDetail", () => {
	it("returns the SkillHub summary, stats, and SKILL.md", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({
				skill: {
					summary: "English summary",
					summary_zh: "中文简介",
					tags: { latest: "0.1.0" },
					stats: { downloads: 12, stars: 3 },
					category: "design",
					githubAuthorLogin: "gituser",
					sourceUrl: "https://clawhub.ai/u/s",
				},
			}))
			.mockResolvedValueOnce(jsonResponse({ files: [{ path: "docs/guide.md" }, { path: "SKILL.md" }] }))
			.mockResolvedValueOnce(textResponse("---\nname: hub\n---\nbody"));
		const detail = await marketSkillDetail({
			id: "ns/hub-skill",
			source: "skillhub.cn",
			name: "hub",
			pageUrl: "https://skillhub.cn/skills?keyword=hub",
			slug: "hub-skill",
			namespace: "ns",
			installable: true,
		});
		expect(detail).toMatchObject({
			description: "中文简介",
			version: "0.1.0",
			downloads: 12,
			stars: 3,
			category: "design",
			author: "gituser",
			sourceUrl: "https://clawhub.ai/u/s",
		});
		expect(detail.readme).toContain("name: hub");
	});

	it("returns the skills.sh meta description and GitHub readme", async () => {
		fetchMock
			.mockResolvedValueOnce(textResponse('<meta name="description" content="Cool &amp; useful">'))
			.mockResolvedValueOnce(jsonResponse({ tree: [{ path: "skills/demo/SKILL.md", type: "blob" }] }))
			.mockResolvedValueOnce(textResponse("github body"));
		const detail = await marketSkillDetail(skillsShSkill({ repo: "o/readme-repo", id: "o/readme-repo/demo" }));
		expect(detail.description).toBe("Cool & useful");
		expect(detail.readme).toBe("github body");
		expect(fetchMock.mock.calls[2][0]).toBe("https://raw.githubusercontent.com/o/readme-repo/HEAD/skills/demo/SKILL.md");
	});
});

describe("pickSkillDirectory", () => {
	it("prefers a folder whose name matches the skill", () => {
		expect(pickSkillDirectory(["skills/alpha", "skills/beta"], "beta", "a/b")).toBe("skills/beta");
	});

	it("falls back to the only skill in the repository", () => {
		expect(pickSkillDirectory(["skills/only"], "missing", "a/b")).toBe("skills/only");
	});

	it("supports a skill at the repository root", () => {
		expect(pickSkillDirectory([""], "repo-name", "o/repo-name")).toBe("");
	});
});
