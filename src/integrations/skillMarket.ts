/*
 * Copyright (c) 2026 Yao
 *
 * This file is part of AiWorkHarness — AI coding agent chat inside VS Code.
 * https://github.com/westhack/ai-work-harness-vs
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

/** Public skill registries that can be browsed and installed from. */
export type SkillMarketSource = "skills.sh" | "skillhub.cn";

export const SKILL_MARKET_SOURCES: { id: SkillMarketSource; label: string }[] = [
	{ id: "skills.sh", label: "skills.sh" },
	{ id: "skillhub.cn", label: "SkillHub" },
];

/** Ordering shared by both registries. */
export type MarketSort = "popular" | "trending";

function hubSort(sort: MarketSort): string {
	return sort === "trending" ? "trending" : "downloads";
}

export interface MarketSkill {
	/** Stable id inside its source. */
	id: string;
	source: SkillMarketSource;
	name: string;
	description?: string;
	author?: string;
	installs?: number;
	version?: string;
	pageUrl: string;
	/** GitHub owner/repo (skills.sh). */
	repo?: string;
	/** Skill folder inside the repo (skills.sh). */
	skill?: string;
	/** SkillHub slug and namespace. */
	slug?: string;
	namespace?: string;
	/** False when the entry cannot be downloaded directly. */
	installable: boolean;
}

export interface SkillInstallResult {
	ok: boolean;
	path?: string;
	detail?: string;
}

const SKILLS_SH = "https://skills.sh";
const SKILLHUB_API = "https://api.skillhub.cn";
const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 25_000;
/** Refuse runaway packages that would flood the skills folder. */
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_FILE_BYTES = 12 * 1024 * 1024;

/** Global folder scanned by the workspace skill loader. */
export function skillInstallRoot(): string {
	return path.join(homedir(), ".aiworkharness", "skills");
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function request(url: string): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { "User-Agent": "AiWorkHarness", Accept: "application/json, text/plain, */*" },
			redirect: "follow",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(`Network request failed: ${(error as Error)?.message || error}`);
	}
	if (!response.ok) {
		if (response.status === 403 && url.includes("api.github.com")) {
			throw new Error("GitHub API rate limit reached. Try again later.");
		}
		throw new Error(`Request failed (${response.status}) for ${url}`);
	}
	return response;
}

async function fetchJson(url: string): Promise<unknown> {
	return request(url).then((response) => response.json());
}

async function fetchText(url: string): Promise<string> {
	return request(url).then((response) => response.text());
}

async function fetchBytes(url: string): Promise<Buffer> {
	const response = await request(url);
	return Buffer.from(await response.arrayBuffer());
}

/** skills.sh only hosts GitHub repositories; `site/…` entries need their CLI. */
export function githubRepo(source: string): string | undefined {
	if (source.startsWith("site/")) return undefined;
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source) ? source : undefined;
}

interface SkillsShHit {
	source?: unknown;
	skillId?: unknown;
	name?: unknown;
	installs?: unknown;
}

interface SkillHubEntry {
	name?: unknown;
	slug?: unknown;
	description?: unknown;
	description_zh?: unknown;
	downloads?: unknown;
	installs?: unknown;
	version?: unknown;
	namespace?: { handle?: unknown; publicSlug?: unknown };
	homepage?: unknown;
}

interface GitHubTreeEntry {
	path?: unknown;
	type?: unknown;
}

/** One page of market entries. */
export interface MarketPage {
	results: MarketSkill[];
	total?: number;
	hasMore: boolean;
}

export const MARKET_PAGE_SIZE = 30;
const CACHE_TTL_MS = 5 * 60_000;
const itemCache = new Map<string, { at: number; items: MarketSkill[] }>();

function cached(key: string, load: () => Promise<MarketSkill[]>): Promise<MarketSkill[]> {
	const hit = itemCache.get(key);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.items);
	return load().then((items) => {
		if (itemCache.size > 60) itemCache.clear();
		itemCache.set(key, { at: Date.now(), items });
		return items;
	});
}

function paginate(items: MarketSkill[], page: number, pageSize: number): MarketPage {
	const size = Math.max(1, pageSize);
	const start = Math.max(0, (Math.max(1, page) - 1) * size);
	const results = items.slice(start, start + size);
	return { results, total: items.length, hasMore: start + results.length < items.length };
}

/** Map raw SkillHub rows to market entries. */
function hubMarketSkills(rows: SkillHubEntry[] | undefined): MarketSkill[] {
	const entries = Array.isArray(rows) ? rows : [];
	return entries.map((entry): MarketSkill => {
		const slug = text(entry.slug) || text(entry.namespace?.publicSlug);
		const namespace = text(entry.namespace?.handle);
		const name = text(entry.name) || slug;
		return {
			id: `${namespace}/${slug}`,
			source: "skillhub.cn",
			name,
			description: text(entry.description_zh) || text(entry.description),
			author: namespace || undefined,
			installs: number(entry.downloads) ?? number(entry.installs),
			version: text(entry.version) || undefined,
			pageUrl: text(entry.homepage) || `https://skillhub.cn/skills?keyword=${encodeURIComponent(name)}`,
			slug,
			namespace,
			installable: !!slug,
		};
	});
}

interface HubPage {
	data?: { skills?: SkillHubEntry[]; total?: unknown };
}

function hubPage(data: HubPage, page: number, pageSize: number): MarketPage {
	const results = hubMarketSkills(data?.data?.skills);
	const total = typeof data?.data?.total === "number" ? data.data.total : undefined;
	return {
		results,
		total,
		hasMore: total !== undefined ? page * pageSize < total : results.length >= pageSize,
	};
}

async function skillsShSearch(keyword: string): Promise<MarketSkill[]> {
	const data = (await fetchJson(`${SKILLS_SH}/api/search?q=${encodeURIComponent(keyword)}`)) as { skills?: SkillsShHit[] };
	const hits = Array.isArray(data?.skills) ? data.skills : [];
	return hits.flatMap((hit): MarketSkill[] => {
		const repo = text(hit.source);
		const skill = text(hit.skillId);
		if (!repo || !skill) return [];
		return [{
			id: `${repo}/${skill}`,
			source: "skills.sh",
			name: text(hit.name) || skill,
			author: repo,
			installs: number(hit.installs),
			pageUrl: `${SKILLS_SH}/${repo}/${skill}`,
			repo,
			skill,
			installable: !!githubRepo(repo),
		}];
	});
}

/** skills.sh renders its leaderboard server-side; parse every skill link. */
async function skillsShFeed(sort: MarketSort): Promise<MarketSkill[]> {
	const page = sort === "trending" ? `${SKILLS_SH}/trending` : `${SKILLS_SH}/`;
	const html = await fetchText(page);
	const seen = new Set<string>();
	const items: MarketSkill[] = [];
	for (const match of html.matchAll(/href="\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)"/g)) {
		const [, repoOwner, repoName, skill] = match;
		if (repoOwner === "site" || repoOwner === "api" || repoOwner === "_next") continue;
		const repo = `${repoOwner}/${repoName}`;
		const id = `${repo}/${skill}`;
		if (seen.has(id)) continue;
		seen.add(id);
		items.push({
			id,
			source: "skills.sh",
			name: skill,
			author: repo,
			pageUrl: `${SKILLS_SH}/${id}`,
			repo,
			skill,
			installable: true,
		});
	}
	return items;
}

/** Search one registry. */
export async function searchMarketSkills(
	source: SkillMarketSource,
	query: string,
	page = 1,
	pageSize = MARKET_PAGE_SIZE,
	sort: MarketSort = "popular",
): Promise<MarketPage> {
	const keyword = query.trim();
	if (!keyword) return { results: [], hasMore: false };
	if (source === "skills.sh") {
		const items = await cached(`search:${keyword.toLowerCase()}`, () => skillsShSearch(keyword));
		return paginate(items, page, pageSize);
	}
	const url = `${SKILLHUB_API}/api/skills?page=${page}&pageSize=${pageSize}&keyword=${encodeURIComponent(keyword)}&sortBy=${hubSort(sort)}&order=desc`;
	return hubPage((await fetchJson(url)) as HubPage, page, pageSize);
}

/**
 * Popular entries shown before the user types a query. SkillHub pages through
 * its JSON listing; skills.sh has no listing API, so its leaderboard links are
 * parsed once and paged locally.
 */
export async function listMarketSkills(
	source: SkillMarketSource,
	page = 1,
	pageSize = MARKET_PAGE_SIZE,
	sort: MarketSort = "popular",
): Promise<MarketPage> {
	if (source === "skillhub.cn") {
		const url = `${SKILLHUB_API}/api/skills?page=${page}&pageSize=${pageSize}&sortBy=${hubSort(sort)}&order=desc`;
		return hubPage((await fetchJson(url)) as HubPage, page, pageSize);
	}
	const items = await cached(`feed:${sort}`, () => skillsShFeed(sort));
	return paginate(items, page, pageSize);
}

function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80);
}

/** Resolve `relative` inside `root`, refusing anything that escapes it. */
function insideRoot(root: string, relative: string): string {
	const full = path.resolve(root, relative);
	if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`Refusing unsafe path: ${relative}`);
	return full;
}

interface WriteJob {
	relative: string;
	load: () => Promise<Buffer>;
}

async function writeSkillFiles(dir: string, jobs: WriteJob[], onLine?: (line: string) => void): Promise<void> {
	let total = 0;
	for (let index = 0; index < jobs.length; index += 1) {
		const job = jobs[index];
		const target = insideRoot(dir, job.relative);
		onLine?.(`(${index + 1}/${jobs.length}) ${job.relative}`);
		const body = await job.load();
		if (body.length > MAX_FILE_BYTES) throw new Error(`File is too large: ${job.relative}`);
		total += body.length;
		if (total > MAX_TOTAL_BYTES) throw new Error("Skill package exceeds the download limit.");
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, body);
	}
}

function encodePath(relative: string): string {
	return relative.split("/").map(encodeURIComponent).join("/");
}

interface SkillHubFiles {
	files?: { path?: unknown; size?: unknown }[];
}

async function skillHubInstall(skill: MarketSkill): Promise<WriteJob[]> {
	const slug = skill.slug ?? "";
	const namespace = skill.namespace ?? "";
	if (!slug || !/^[A-Za-z0-9._-]+$/.test(slug) || !/^[A-Za-z0-9._-]+$/.test(namespace)) {
		throw new Error("This entry is missing its SkillHub coordinates.");
	}
	const listing = (await fetchJson(
		`${SKILLHUB_API}/api/v1/skills/${encodeURIComponent(slug)}/files?namespace=${encodeURIComponent(namespace)}`,
	)) as SkillHubFiles;
	const files = Array.isArray(listing?.files) ? listing.files : [];
	const jobs: WriteJob[] = [];
	for (const file of files) {
		const relative = text(file.path);
		if (!relative || relative.endsWith("/")) continue;
		const url = `${SKILLHUB_API}/api/v1/skills/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(relative)}&namespace=${encodeURIComponent(namespace)}`;
		jobs.push({ relative, load: () => fetchBytes(url) });
	}
	if (!jobs.length) throw new Error("SkillHub returned no files for this skill.");
	return jobs;
}

interface GitHubTree {
	tree?: GitHubTreeEntry[];
	truncated?: boolean;
}

/** Pick the folder that holds the requested SKILL.md. */
export function pickSkillDirectory(dirs: string[], wanted: string, repo: string): string | undefined {
	const want = wanted.toLowerCase();
	const named = dirs.find((dir) => (dir.split("/").filter(Boolean).pop() ?? "").toLowerCase() === want);
	if (named !== undefined) return named;
	const exact = dirs.find((dir) => dir.toLowerCase() === want);
	if (exact !== undefined) return exact;
	if (dirs.length === 1) return dirs[0];
	const repoName = repo.split("/").pop()?.toLowerCase() ?? "";
	return dirs.find((dir) => (dir.split("/").filter(Boolean).pop() ?? "").toLowerCase() === repoName);
}

async function gitHubInstall(skill: MarketSkill): Promise<WriteJob[]> {
	const repo = skill.repo ?? "";
	if (!githubRepo(repo)) throw new Error("This entry is not hosted on GitHub, so it cannot be installed here.");
	const tree = await gitHubTree(repo);
	const dirs = skillDirs(tree);
	if (!dirs.length) throw new Error("No SKILL.md found in this repository.");
	const dir = pickSkillDirectory(dirs, skill.skill || skill.name, repo);
	if (dir === undefined) throw new Error(`Could not find the ${skill.skill || skill.name} skill in ${repo}.`);
	const prefix = dir ? `${dir}/` : "";
	const jobs: WriteJob[] = [];
	for (const entry of tree) {
		const file = text(entry.path);
		if (text(entry.type) !== "blob" || !file.startsWith(prefix)) continue;
		if (path.posix.basename(file) === ".git") continue;
		const relative = file.slice(prefix.length);
		if (!relative) continue;
		jobs.push({
			relative,
			load: () => fetchBytes(`https://raw.githubusercontent.com/${repo}/HEAD/${encodePath(file)}`),
		});
	}
	if (!jobs.length) throw new Error("The skill folder is empty.");
	return jobs;
}

/** Everything the detail panel shows for one market entry. */
export interface MarketSkillDetail {
	description: string;
	author?: string;
	version?: string;
	downloads?: number;
	stars?: number;
	category?: string;
	updatedAt?: string;
	sourceUrl?: string;
	readme: string;
}

interface SkillHubDetail {
	skill?: {
		summary?: unknown;
		summary_zh?: unknown;
		category?: unknown;
		tags?: { latest?: unknown };
		stats?: { downloads?: unknown; stars?: unknown };
		updatedAt?: unknown;
		githubAuthorLogin?: unknown;
		sourceUrl?: unknown;
	};
}

function hubCoordinates(skill: MarketSkill): { slug: string; namespace: string } {
	const slug = skill.slug ?? "";
	const namespace = skill.namespace ?? "";
	if (!/^[A-Za-z0-9._-]+$/.test(slug) || !/^[A-Za-z0-9._-]+$/.test(namespace)) {
		throw new Error("This entry is missing its SkillHub coordinates.");
	}
	return { slug, namespace };
}

async function hubSkillReadme(slug: string, namespace: string): Promise<string> {
	const listing = (await fetchJson(
		`${SKILLHUB_API}/api/v1/skills/${encodeURIComponent(slug)}/files?namespace=${encodeURIComponent(namespace)}`,
	)) as SkillHubFiles;
	const files = (Array.isArray(listing?.files) ? listing.files : []).map((file) => text(file.path));
	const skillFile = files.find((file) => file === "SKILL.md") ?? files.find((file) => file.endsWith("/SKILL.md"));
	if (!skillFile) throw new Error("This skill has no SKILL.md.");
	const url = `${SKILLHUB_API}/api/v1/skills/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(skillFile)}&namespace=${encodeURIComponent(namespace)}`;
	return (await fetchText(url)).slice(0, 20_000);
}

async function gitHubSkillReadme(skill: MarketSkill): Promise<string> {
	const repo = skill.repo ?? "";
	if (!githubRepo(repo)) throw new Error("This entry is not hosted on GitHub.");
	const tree = await gitHubTree(repo);
	const dir = pickSkillDirectory(skillDirs(tree), skill.skill || skill.name, repo);
	if (dir === undefined) throw new Error(`Could not find the ${skill.skill || skill.name} skill in ${repo}.`);
	const file = dir ? `${dir}/SKILL.md` : "SKILL.md";
	return (await fetchText(`https://raw.githubusercontent.com/${repo}/HEAD/${encodePath(file)}`)).slice(0, 20_000);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };

function decodeEntities(value: string): string {
	return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);
}

/** skills.sh pages are server-rendered, so the meta description carries the summary. */
function metaDescription(html: string): string {
	const match = html.match(/<meta[^>]+(?:name|property)="(?:og:)?description"[^>]+content="([^"]*)"/i)
		?? html.match(/<meta[^>]+content="([^"]*)"[^>]+(?:name|property)="(?:og:)?description"/i);
	const raw = match?.[1] ?? "";
	return decodeEntities(raw).trim();
}

/** Description, metadata, and SKILL.md for the market detail panel. */
export async function marketSkillDetail(skill: MarketSkill): Promise<MarketSkillDetail> {
	if (skill.source === "skillhub.cn") {
		const { slug, namespace } = hubCoordinates(skill);
		const info = (await fetchJson(`${SKILLHUB_API}/api/v1/skills/${encodeURIComponent(slug)}?namespace=${encodeURIComponent(namespace)}`)) as SkillHubDetail;
		let readme = "";
		let readmeError = "";
		try {
			readme = await hubSkillReadme(slug, namespace);
		} catch (error) {
			readmeError = String((error as Error)?.message || error);
		}
		const updated = Number(info?.skill?.updatedAt);
		return {
			description: text(info?.skill?.summary_zh) || text(info?.skill?.summary) || skill.description || "",
			version: text(info?.skill?.tags?.latest) || skill.version,
			downloads: number(info?.skill?.stats?.downloads) ?? skill.installs,
			stars: number(info?.skill?.stats?.stars),
			category: text(info?.skill?.category),
			author: text(info?.skill?.githubAuthorLogin) || namespace,
			updatedAt: Number.isFinite(updated) && updated > 0 ? new Date(updated).toISOString().slice(0, 10) : undefined,
			sourceUrl: text(info?.skill?.sourceUrl) || skill.pageUrl,
			readme: readme || readmeError,
		};
	}
	let description = skill.description ?? "";
	let readme = "";
	try {
		description = metaDescription(await fetchText(skill.pageUrl)) || description;
		readme = await gitHubSkillReadme(skill);
	} catch (error) {
		readme = String((error as Error)?.message || error);
	}
	return {
		description,
		author: skill.author,
		downloads: skill.installs,
		sourceUrl: skill.pageUrl,
		readme,
	};
}

function skillDirs(tree: GitHubTreeEntry[]): string[] {
	const dirs: string[] = [];
	for (const entry of tree) {
		const file = text(entry.path);
		if (text(entry.type) !== "blob") continue;
		if (file === "SKILL.md") dirs.push("");
		else if (file.endsWith("/SKILL.md")) dirs.push(file.slice(0, -"/SKILL.md".length));
	}
	return dirs;
}

const treeCache = new Map<string, { at: number; tree: GitHubTreeEntry[] }>();

async function gitHubTree(repo: string): Promise<GitHubTreeEntry[]> {
	const hit = treeCache.get(repo);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tree;
	const data = (await fetchJson(`${GITHUB_API}/repos/${repo}/git/trees/HEAD?recursive=1`)) as GitHubTree;
	const tree = Array.isArray(data?.tree) ? data.tree : [];
	if (!tree.length) throw new Error("Could not read the repository file list.");
	if (treeCache.size > 60) treeCache.clear();
	treeCache.set(repo, { at: Date.now(), tree });
	return tree;
}

/** Download one market entry into the global skills folder. */
export async function installMarketSkill(
	skill: MarketSkill,
	onLine?: (line: string) => void,
): Promise<SkillInstallResult> {
	if (!skill.installable) return { ok: false, detail: "This entry cannot be installed directly." };
	const name = safeSegment(skill.slug || skill.name || skill.skill || "");
	if (!name) return { ok: false, detail: "This entry has no usable name." };
	const root = skillInstallRoot();
	const target = path.join(root, name);
	if (existsSync(target)) return { ok: false, detail: `Already installed at ${target}` };
	let jobs: WriteJob[];
	try {
		jobs = skill.source === "skills.sh" ? await gitHubInstall(skill) : await skillHubInstall(skill);
		await writeSkillFiles(target, jobs, onLine);
	} catch (error) {
		await rm(target, { recursive: true, force: true }).catch(() => undefined);
		return { ok: false, detail: (error as Error)?.message || String(error) };
	}
	if (!existsSync(path.join(target, "SKILL.md"))) {
		return { ok: false, detail: "The downloaded package has no SKILL.md." };
	}
	return { ok: true, path: target };
}
