/**
 * WakaTime-compatible project naming.
 *
 * The cost ledger buckets spend by project, and "project" has to mean the same thing here as it
 * does on the user's WakaTime dashboard — otherwise two views of the same day disagree.
 * wakatime-cli resolves a name in a fixed order (`pkg/project/project.go`): a `.wakatime-project`
 * file, then the `[projectmap]` section of `~/.wakatime.cfg`, then the enclosing repository
 * folder, then the folder's own name. This module replays that order for a *directory* instead of
 * the file entity a heartbeat carries.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { readWakatimeCfgSection } from "../wakatime/config";

/** Which of wakatime-cli's rules produced the name. */
export type ProjectNameSource = "file" | "projectmap" | "git" | "basename";

/** A project name plus the rule that produced it. */
export interface ResolvedProjectName {
	project: string;
	source: ProjectNameSource;
}

/** wakatime-cli's `project.WakaTimeProjectFile`. */
const PROJECT_FILE = ".wakatime-project";

interface ProjectMapRule {
	pattern: RegExp;
	name: string;
}

/** Resolved names keyed by absolute directory: every miss walks the tree and reads config files. */
const resolved = new Map<string, ResolvedProjectName>();

/** Compiled `[projectmap]`, longest pattern first. `null` until the first resolution needs it. */
let projectMap: ProjectMapRule[] | null = null;

/** `dir` and every ancestor, up to the filesystem root. */
function* selfAndAncestors(dir: string): Generator<string> {
	let current = dir;
	for (;;) {
		yield current;
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

/**
 * First `.wakatime-project` at or above `dir` wins, and its first non-empty line is the name.
 * wakatime-cli reads only two lines from that file; the second is a branch override we ignore.
 * A marker file with no usable line yields nothing and resolution falls through to the next rule,
 * which is also what upstream does with an empty project name.
 */
async function fromProjectFile(dir: string): Promise<string | null> {
	for (const candidate of selfAndAncestors(dir)) {
		let text: string;
		try {
			text = await fs.readFile(path.join(candidate, PROJECT_FILE), "utf8");
		} catch {
			// Missing, a directory, or unreadable — none of which pins a name here. Keep walking.
			continue;
		}
		for (const line of text.split("\n")) {
			const name = line.trim();
			if (name.length > 0) return name;
		}
		return null;
	}
	return null;
}

/**
 * Compile `[projectmap]` once per process.
 *
 * wakatime-cli prefixes every pattern with `(?i)` and stores them in a Go map, so when several
 * patterns match, the winner rides on randomised map iteration order. We sort longest-pattern
 * first instead: stricter than the CLI, but deterministic and the intuitive reading of "the most
 * specific rule wins".
 */
async function loadProjectMap(): Promise<ProjectMapRule[]> {
	if (projectMap) return projectMap;
	const rules: ProjectMapRule[] = [];
	for (const [source, name] of await readWakatimeCfgSection("projectmap")) {
		try {
			rules.push({ pattern: new RegExp(source, "i"), name });
		} catch (err) {
			logger.debug("usage: ignoring unparsable [projectmap] pattern", { pattern: source, err });
		}
	}
	rules.sort((a, b) => b.pattern.source.length - a.pattern.source.length);
	projectMap = rules;
	return rules;
}

/**
 * `{0}` is the FIRST capture group: wakatime-cli formats the rule's value with Python's
 * `str.format` over `matches[1:]`, so group N lands in `{N-1}`. A placeholder with no capture
 * group behind it makes upstream skip the rule, and so do we — better than attributing spend to a
 * project literally named `project{3}`.
 */
function interpolate(name: string, match: RegExpExecArray): string | null {
	let complete = true;
	const interpolated = name.replace(/\{(\d+)\}/g, (_placeholder, index: string) => {
		const group = Number(index) + 1;
		if (group >= match.length) {
			complete = false;
			return "";
		}
		// A group that exists but matched nothing is `undefined` here, while Go's
		// FindStringSubmatch hands pyfmt an empty string for it. Follow Go.
		return match[group] ?? "";
	});
	return complete ? interpolated : null;
}

/**
 * wakatime-cli matches `[projectmap]` against the *entity* path — a file — so directory rules are
 * written with a trailing slash (`^/home/me/Projects/([^/]+)/`). We resolve directories, so every
 * rule is tried against the bare path and against the prefix a file inside it would share.
 */
async function fromProjectMap(dir: string): Promise<string | null> {
	const rules = await loadProjectMap();
	if (rules.length === 0) return null;
	const candidates = dir.endsWith(path.sep) ? [dir] : [dir, `${dir}${path.sep}`];
	for (const rule of rules) {
		for (const candidate of candidates) {
			const match = rule.pattern.exec(candidate);
			if (!match) continue;
			const name = interpolate(rule.name, match);
			if (name !== null && name.length > 0) return name;
		}
	}
	return null;
}

/**
 * Nearest ancestor holding a `.git` entry names the project. `.git` is a directory in an ordinary
 * clone but a file in linked worktrees and submodules, so presence — not kind — is the test.
 */
async function fromGit(dir: string): Promise<string | null> {
	for (const candidate of selfAndAncestors(dir)) {
		try {
			await fs.access(path.join(candidate, ".git"));
			return path.basename(candidate) || null;
		} catch {
			// No repository marker at this level.
		}
	}
	return null;
}

async function detect(dir: string): Promise<ResolvedProjectName> {
	try {
		const pinned = await fromProjectFile(dir);
		if (pinned) return { project: pinned, source: "file" };
		const mapped = await fromProjectMap(dir);
		if (mapped) return { project: mapped, source: "projectmap" };
		const repository = await fromGit(dir);
		if (repository) return { project: repository, source: "git" };
	} catch (err) {
		// Attribution must never break its caller; an unreadable tree just means a duller name.
		logger.debug("usage: project detection failed, falling back to the directory name", { dir, err });
	}
	return { project: path.basename(dir) || dir, source: "basename" };
}

/**
 * Resolve the WakaTime-compatible project name for a directory and report which rule produced it.
 * Never throws.
 */
export async function resolveProjectNameDetailed(cwd: string): Promise<ResolvedProjectName> {
	const dir = path.resolve(cwd);
	const cached = resolved.get(dir);
	if (cached) return cached;
	const result = await detect(dir);
	resolved.set(dir, result);
	return result;
}

/**
 * Resolve the WakaTime-compatible project name for a directory, in wakatime-cli's own precedence
 * order. Never throws.
 */
export async function resolveProjectName(cwd: string): Promise<string> {
	return (await resolveProjectNameDetailed(cwd)).project;
}

/** Clears the internal per-directory cache and the compiled `[projectmap]`. For tests. */
export function clearProjectNameCache(): void {
	resolved.clear();
	projectMap = null;
}
