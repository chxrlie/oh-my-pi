import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearProjectNameCache,
	resolveProjectName,
	resolveProjectNameDetailed,
} from "@oh-my-pi/pi-coding-agent/usage/project-resolver";

let root: string;
let previousWakatimeHome: string | undefined;

/**
 * `~/.wakatime.cfg` is found through `$WAKATIME_HOME`, so every test gets its own home and the
 * developer's real projectmap can never leak in. `root/home` stays empty unless a test writes a
 * cfg, which is the "no rules configured" baseline.
 */
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-project-resolver-"));
	await fs.mkdir(path.join(root, "home"));
	previousWakatimeHome = process.env.WAKATIME_HOME;
	process.env.WAKATIME_HOME = path.join(root, "home");
	clearProjectNameCache();
});

afterEach(async () => {
	if (previousWakatimeHome === undefined) delete process.env.WAKATIME_HOME;
	else process.env.WAKATIME_HOME = previousWakatimeHome;
	clearProjectNameCache();
	await fs.rm(root, { recursive: true, force: true });
});

/** Create `root/<segments>` and hand back its absolute path. */
async function makeDir(...segments: string[]): Promise<string> {
	const dir = path.join(root, ...segments);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

/** Overwrite the temp home's `~/.wakatime.cfg` with a `[projectmap]` section holding `rules`. */
async function writeProjectmap(...rules: string[]): Promise<void> {
	const cfg = ["[settings]", "debug = false", "", "[projectmap]", ...rules, ""].join("\n");
	await fs.writeFile(path.join(root, "home", ".wakatime.cfg"), cfg);
}

describe("resolveProjectName precedence", () => {
	it("prefers a .wakatime-project file over projectmap, git, and the directory name", async () => {
		const repo = await makeDir("repo");
		await fs.mkdir(path.join(repo, ".git"));
		await fs.writeFile(path.join(repo, ".wakatime-project"), "Pinned Name\n");
		await writeProjectmap(`${escapeRegex(repo)} = Mapped Name`);

		expect(await resolveProjectNameDetailed(repo)).toEqual({ project: "Pinned Name", source: "file" });
	});

	it("finds a .wakatime-project file on an ancestor and skips its leading blank lines", async () => {
		const repo = await makeDir("repo");
		const nested = await makeDir("repo", "packages", "core", "src");
		await fs.writeFile(path.join(repo, ".wakatime-project"), "\n   \nAncestor Pinned\nsome-branch\n");

		expect(await resolveProjectName(nested)).toBe("Ancestor Pinned");
	});

	it("falls through to the next rule when the marker file has no usable line", async () => {
		const repo = await makeDir("empty-marker");
		await fs.mkdir(path.join(repo, ".git"));
		await fs.writeFile(path.join(repo, ".wakatime-project"), "\n\n");

		expect(await resolveProjectNameDetailed(repo)).toEqual({ project: "empty-marker", source: "git" });
	});

	it("prefers a projectmap rule over git and the directory name", async () => {
		const repo = await makeDir("workspace", "checkout");
		await fs.mkdir(path.join(repo, ".git"));
		await writeProjectmap(`${escapeRegex(repo)} = Mapped Name`);

		expect(await resolveProjectNameDetailed(repo)).toEqual({ project: "Mapped Name", source: "projectmap" });
	});

	it("names the nearest git repository folder when no rule matches", async () => {
		const repo = await makeDir("my-repo");
		await fs.mkdir(path.join(repo, ".git"));
		const nested = await makeDir("my-repo", "src", "deep");

		expect(await resolveProjectNameDetailed(nested)).toEqual({ project: "my-repo", source: "git" });
	});

	it("treats a .git file as a repository marker, so worktrees and submodules resolve", async () => {
		const worktree = await makeDir("linked-worktree");
		await fs.writeFile(path.join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/linked-worktree\n");
		const nested = await makeDir("linked-worktree", "src");

		expect(await resolveProjectNameDetailed(nested)).toEqual({ project: "linked-worktree", source: "git" });
	});

	it("falls back to the directory name when nothing else applies", async () => {
		const plain = await makeDir("just-a-folder");

		expect(await resolveProjectNameDetailed(plain)).toEqual({ project: "just-a-folder", source: "basename" });
	});
});

describe("projectmap rules", () => {
	it("interpolates capture groups, with {0} standing for the FIRST group", async () => {
		const projects = await makeDir("Projects");
		const repo = await makeDir("Projects", "web-clock");
		await writeProjectmap(`^${escapeRegex(projects)}/([^/]+)/ = {0}`);

		expect(await resolveProjectNameDetailed(repo)).toEqual({ project: "web-clock", source: "projectmap" });
	});

	it("interpolates later groups from their zero-based placeholder", async () => {
		const repo = await makeDir("acme", "billing");
		await writeProjectmap(`^${escapeRegex(root)}/([^/]+)/([^/]+)/ = {1}@{0}`);

		expect(await resolveProjectName(repo)).toBe("billing@acme");
	});

	it("matches patterns case-insensitively, like wakatime-cli's forced (?i)", async () => {
		const repo = await makeDir("CamelCase");
		await writeProjectmap(`${escapeRegex(root).toLowerCase()}/camelcase = Case Insensitive`);

		expect(await resolveProjectName(repo)).toBe("Case Insensitive");
	});

	it("picks the longest matching pattern, which wakatime-cli leaves to map iteration order", async () => {
		const repo = await makeDir("mono", "packages", "api");
		await writeProjectmap(
			`${escapeRegex(path.join(root, "mono"))} = Whole Monorepo`,
			`${escapeRegex(repo)} = Api Package`,
		);

		expect(await resolveProjectName(repo)).toBe("Api Package");
	});

	it("skips a rule whose placeholder has no capture group behind it", async () => {
		const repo = await makeDir("no-groups");
		await fs.mkdir(path.join(repo, ".git"));
		await writeProjectmap(`${escapeRegex(repo)} = broken{3}`);

		expect(await resolveProjectNameDetailed(repo)).toEqual({ project: "no-groups", source: "git" });
	});

	it("substitutes an empty string for a group that exists but matched nothing", async () => {
		const repo = await makeDir("suffixless");
		await writeProjectmap(`${escapeRegex(repo)}(-[a-z]+)?$ = repo{0}`);

		expect(await resolveProjectName(repo)).toBe("repo");
	});

	it("ignores an unparsable pattern instead of failing the whole resolution", async () => {
		const repo = await makeDir("survivor");
		await writeProjectmap("([unclosed = Never Used", `${escapeRegex(repo)} = Still Mapped`);

		expect(await resolveProjectName(repo)).toBe("Still Mapped");
	});

	it("matches directory rules written with a trailing slash for file entities", async () => {
		const repo = await makeDir("Zettelkasten");
		await writeProjectmap(`^${escapeRegex(repo)}/ = Notes`);

		expect(await resolveProjectName(repo)).toBe("Notes");
	});
});

describe("caching", () => {
	it("memoises per directory and re-resolves after clearProjectNameCache", async () => {
		const repo = await makeDir("cached");
		const marker = path.join(repo, ".wakatime-project");
		await fs.writeFile(marker, "First\n");
		expect(await resolveProjectName(repo)).toBe("First");

		await fs.writeFile(marker, "Second\n");
		expect(await resolveProjectName(repo)).toBe("First");

		clearProjectNameCache();
		expect(await resolveProjectName(repo)).toBe("Second");
	});

	it("keys the cache on the resolved absolute path, so unnormalised input hits the same entry", async () => {
		const repo = await makeDir("resolved-key");
		const marker = path.join(repo, ".wakatime-project");
		await fs.writeFile(marker, "Absolute\n");

		// Built by hand: `path.join` would collapse the `..` before the resolver ever saw it.
		expect(await resolveProjectName(`${repo}/nested/..`)).toBe("Absolute");

		// Same directory, so the memoised entry answers and the rewritten marker is not re-read.
		await fs.writeFile(marker, "Rewritten\n");
		expect(await resolveProjectName(repo)).toBe("Absolute");
	});

	it("drops compiled projectmap rules too, so a rewritten cfg takes effect", async () => {
		const repo = await makeDir("recompiled");
		await writeProjectmap(`${escapeRegex(repo)} = Before`);
		expect(await resolveProjectName(repo)).toBe("Before");

		await writeProjectmap(`${escapeRegex(repo)} = After`);
		clearProjectNameCache();
		expect(await resolveProjectName(repo)).toBe("After");
	});
});

/** Temp-dir paths carry `-` and `/`; only the regex metacharacters need neutralising. */
function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
