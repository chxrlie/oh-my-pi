import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CommandResult,
	type CommandRunner,
	describeOverlayPlan,
	type OverlayConfig,
	type OverlayDeps,
	OverlayUpdateError,
	overlayBuildOutputCandidates,
	overlayNeedsRebuild,
	overlayStampPath,
	parseGitRemotes,
	pickOverlayRemote,
	readOverlayHeadCommit,
	readOverlayStamp,
	releaseTagFor,
	remoteMatchesRepo,
	runOverlayUpdate,
	writeOverlayStamp,
} from "../src/cli/update-overlay";

const REPO_SLUG = "can1357/oh-my-pi";
const REPO_ROOT = "/home/dev/oh-my-pi";

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "" };

function out(stdout: string): CommandResult {
	return { exitCode: 0, stdout, stderr: "" };
}

function fail(stderr: string, exitCode = 1): CommandResult {
	return { exitCode, stdout: "", stderr };
}

interface ScriptedRun {
	readonly calls: string[][];
	readonly run: CommandRunner;
}

/**
 * Command runner driven by a prefix→result table. Keys are matched as a joined
 * argv prefix so a test only pins the commands it cares about; anything
 * unmatched succeeds silently, and every invocation is recorded in order.
 */
function scriptRunner(table: Record<string, CommandResult>): ScriptedRun {
	const calls: string[][] = [];
	const entries = Object.entries(table).sort((a, b) => b[0].length - a[0].length);
	const run: CommandRunner = async argv => {
		const joined = argv.join(" ");
		calls.push([...argv]);
		for (const [prefix, result] of entries) {
			if (joined.startsWith(prefix)) return result;
		}
		return OK;
	};
	return { calls, run };
}

interface HarnessOptions {
	readonly table?: Record<string, CommandResult>;
	readonly config?: Partial<OverlayConfig>;
	readonly existingFiles?: readonly string[];
}

function harness(options: HarnessOptions = {}) {
	const built = overlayBuildOutputCandidates(REPO_ROOT)[0];
	const existing = new Set(options.existingFiles ?? [built]);
	const scripted = scriptRunner({
		"git rev-parse --show-toplevel": out(REPO_ROOT),
		"git status --porcelain": out(""),
		"git symbolic-ref --quiet --short HEAD": out("feat/patches"),
		"git remote -v": out(
			`origin\tgit@github.com:me/oh-my-pi.git (fetch)\norigin\tgit@github.com:me/oh-my-pi.git (push)\nupstream\tgit@github.com:can1357/oh-my-pi.git (fetch)\nupstream\tgit@github.com:can1357/oh-my-pi.git (push)`,
		),
		"git rev-parse HEAD": out("cafebabecafebabecafebabecafebabecafebabe"),
		"git merge-base --is-ancestor": fail("not an ancestor"),
		...options.table,
	});
	const logs: string[] = [];
	const installed: Array<{ builtPath: string; version: string }> = [];
	const deps: OverlayDeps = {
		run: scripted.run,
		log: message => logs.push(message),
		installBinary: async (builtPath, version) => {
			installed.push({ builtPath, version });
		},
		fileExists: async filePath => existing.has(filePath),
	};
	const config: OverlayConfig = { repoPath: REPO_ROOT, ...options.config };
	return { built, calls: scripted.calls, config, deps, installed, logs };
}

function joinedCalls(calls: string[][]): string[] {
	return calls.map(argv => argv.join(" "));
}

describe("releaseTagFor", () => {
	it("prefixes a bare semver and leaves an existing tag alone", () => {
		expect(releaseTagFor("17.2.14")).toBe("v17.2.14");
		expect(releaseTagFor(" v17.2.14 ")).toBe("v17.2.14");
	});
});

describe("parseGitRemotes", () => {
	it("collapses fetch/push pairs and prefers the fetch url", () => {
		const remotes = parseGitRemotes(
			[
				"origin\tgit@github.com:me/fork.git (fetch)",
				"origin\tgit@github.com:me/fork-push.git (push)",
				"upstream\thttps://github.com/can1357/oh-my-pi.git (fetch)",
				"upstream\thttps://github.com/can1357/oh-my-pi.git (push)",
			].join("\n"),
		);
		expect(remotes).toEqual([
			{ name: "origin", url: "git@github.com:me/fork.git" },
			{ name: "upstream", url: "https://github.com/can1357/oh-my-pi.git" },
		]);
	});

	it("ignores lines that are not remote entries", () => {
		expect(parseGitRemotes("fatal: not a git repository\n")).toEqual([]);
	});
});

describe("remoteMatchesRepo", () => {
	it("matches ssh, https and git-suffixed forms of the same repo", () => {
		expect(remoteMatchesRepo("git@github.com:can1357/oh-my-pi.git", REPO_SLUG)).toBe(true);
		expect(remoteMatchesRepo("https://github.com/can1357/oh-my-pi", REPO_SLUG)).toBe(true);
		expect(remoteMatchesRepo("ssh://git@github.com/CAN1357/OH-MY-PI.git", REPO_SLUG)).toBe(true);
	});

	it("rejects a fork of the same repo name", () => {
		expect(remoteMatchesRepo("git@github.com:someone/oh-my-pi.git", REPO_SLUG)).toBe(false);
	});
});

describe("pickOverlayRemote", () => {
	const forkRemotes = [
		{ name: "origin", url: "git@github.com:me/oh-my-pi.git" },
		{ name: "upstream", url: "git@github.com:can1357/oh-my-pi.git" },
	];

	it("picks the remote whose url is upstream, not the one named origin", () => {
		expect(pickOverlayRemote(forkRemotes, REPO_SLUG)).toBe("upstream");
	});

	it("picks by url even when the names are unconventional", () => {
		const remotes = [
			{ name: "fork", url: "git@github.com:me/oh-my-pi.git" },
			{ name: "canonical", url: "https://github.com/can1357/oh-my-pi.git" },
		];
		expect(pickOverlayRemote(remotes, REPO_SLUG)).toBe("canonical");
	});

	it("honours an explicit remote", () => {
		expect(pickOverlayRemote(forkRemotes, REPO_SLUG, "origin")).toBe("origin");
	});

	it("rejects an explicit remote that does not exist", () => {
		expect(() => pickOverlayRemote(forkRemotes, REPO_SLUG, "nope")).toThrow(OverlayUpdateError);
	});

	it("falls back to the only remote when nothing matches by url or name", () => {
		expect(pickOverlayRemote([{ name: "mirror", url: "git@git.example.com:x/y.git" }], REPO_SLUG)).toBe("mirror");
	});

	it("refuses to guess between several unrelated remotes", () => {
		const remotes = [
			{ name: "a", url: "git@git.example.com:x/y.git" },
			{ name: "b", url: "git@git.example.com:x/z.git" },
		];
		expect(() => pickOverlayRemote(remotes, REPO_SLUG)).toThrow(/could not determine which remote/);
	});
});

describe("overlayNeedsRebuild", () => {
	const commit = "a".repeat(40);

	it("rebuilds when nothing was ever stamped", () => {
		expect(overlayNeedsRebuild({ stamp: undefined, headCommit: commit, releaseVersion: "17.2.14" })).toBe(true);
	});

	it("rebuilds when the overlay branch moved at the same release", () => {
		expect(
			overlayNeedsRebuild({
				stamp: { version: "17.2.14", commit },
				headCommit: "b".repeat(40),
				releaseVersion: "17.2.14",
			}),
		).toBe(true);
	});

	it("rebuilds when the release moved under the same overlay commit", () => {
		expect(
			overlayNeedsRebuild({ stamp: { version: "17.2.13", commit }, headCommit: commit, releaseVersion: "17.2.14" }),
		).toBe(true);
	});

	it("skips the rebuild when the stamp matches head and release", () => {
		expect(
			overlayNeedsRebuild({ stamp: { version: "17.2.14", commit }, headCommit: commit, releaseVersion: "17.2.14" }),
		).toBe(false);
	});

	it("rebuilds rather than claiming currency when head is unreadable", () => {
		expect(
			overlayNeedsRebuild({
				stamp: { version: "17.2.14", commit },
				headCommit: undefined,
				releaseVersion: "17.2.14",
			}),
		).toBe(true);
	});
});

describe("overlay stamp io", () => {
	it("round-trips through the sidecar next to the binary", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-stamp-"));
		const target = path.join(dir, "omp");
		try {
			expect(overlayStampPath(target)).toBe(`${target}.overlay.json`);
			expect(await readOverlayStamp(target)).toBeUndefined();
			await writeOverlayStamp(target, { version: "17.2.14", commit: "c".repeat(40) });
			expect(await readOverlayStamp(target)).toEqual({ version: "17.2.14", commit: "c".repeat(40) });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats a corrupt or partial stamp as absent", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-stamp-"));
		const target = path.join(dir, "omp");
		try {
			fs.writeFileSync(overlayStampPath(target), "{not json");
			expect(await readOverlayStamp(target)).toBeUndefined();
			fs.writeFileSync(overlayStampPath(target), JSON.stringify({ version: "17.2.14" }));
			expect(await readOverlayStamp(target)).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("readOverlayHeadCommit", () => {
	it("returns the trimmed sha", async () => {
		const { run } = scriptRunner({ "git rev-parse HEAD": out(`${"d".repeat(40)}\n`) });
		expect(await readOverlayHeadCommit({ repoPath: REPO_ROOT }, run)).toBe("d".repeat(40));
	});

	it("returns undefined when the checkout cannot be read", async () => {
		const { run } = scriptRunner({ "git rev-parse HEAD": fail("not a git repository", 128) });
		expect(await readOverlayHeadCommit({ repoPath: REPO_ROOT }, run)).toBeUndefined();
	});
});

describe("describeOverlayPlan", () => {
	it("names the checkout, branch, remote and the rebase target", () => {
		const plan = describeOverlayPlan({ repoPath: REPO_ROOT, branch: "feat/patches" }, "17.2.14");
		expect(plan.join("\n")).toContain(REPO_ROOT);
		expect(plan.join("\n")).toContain("feat/patches");
		expect(plan.join("\n")).toContain("(auto-detected)");
		expect(plan.join("\n")).toContain("v17.2.14");
	});
});

describe("runOverlayUpdate", () => {
	it("rebases onto the release tag, builds, and installs the built binary", async () => {
		const h = harness();
		const result = await runOverlayUpdate({
			config: h.config,
			expectedVersion: "17.2.14",
			repoSlug: REPO_SLUG,
			deps: h.deps,
		});

		const calls = joinedCalls(h.calls);
		expect(calls).toContain("git fetch --force upstream refs/tags/v17.2.14:refs/tags/v17.2.14");
		expect(calls).toContain("git -c rebase.updateRefs=false rebase v17.2.14");
		expect(calls).toContain("bun install --frozen-lockfile");
		expect(calls).toContain("bun run build");
		expect(h.installed).toEqual([{ builtPath: h.built, version: "17.2.14" }]);
		expect(result).toEqual({
			branch: "feat/patches",
			tag: "v17.2.14",
			commit: "cafebabecafebabecafebabecafebabecafebabe",
			headBefore: "cafebabecafebabecafebabecafebabecafebabe",
		});
	});

	it("refuses to touch a checkout with uncommitted changes", async () => {
		const h = harness({ table: { "git status --porcelain": out(" M src/thing.ts") } });

		await expect(
			runOverlayUpdate({ config: h.config, expectedVersion: "17.2.14", repoSlug: REPO_SLUG, deps: h.deps }),
		).rejects.toThrow(/uncommitted changes/);

		const calls = joinedCalls(h.calls);
		expect(calls.some(call => call.startsWith("git rebase"))).toBe(false);
		expect(calls).not.toContain("bun run build");
		expect(h.installed).toEqual([]);
	});

	it("refuses when the configured branch is not the checked-out one", async () => {
		const h = harness({ config: { branch: "feat/other" } });

		await expect(
			runOverlayUpdate({ config: h.config, expectedVersion: "17.2.14", repoSlug: REPO_SLUG, deps: h.deps }),
		).rejects.toThrow(/not the configured "feat\/other"/);
		expect(h.installed).toEqual([]);
	});

	it("refuses a detached HEAD", async () => {
		const h = harness({
			table: { "git symbolic-ref --quiet --short HEAD": fail("ref HEAD is not a symbolic ref", 1) },
		});

		await expect(
			runOverlayUpdate({ config: h.config, expectedVersion: "17.2.14", repoSlug: REPO_SLUG, deps: h.deps }),
		).rejects.toThrow(/detached HEAD/);
	});

	it("reports a missing release tag instead of building stale code", async () => {
		const h = harness({ table: { "git fetch": fail("couldn't find remote ref refs/tags/v17.2.14", 128) } });

		await expect(
			runOverlayUpdate({ config: h.config, expectedVersion: "17.2.14", repoSlug: REPO_SLUG, deps: h.deps }),
		).rejects.toThrow(/could not fetch release tag v17\.2\.14/);
		expect(joinedCalls(h.calls)).not.toContain("bun run build");
	});

	it("aborts the rebase on conflict and leaves the checkout unchanged", async () => {
		const h = harness({
			table: { "git -c rebase.updateRefs=false rebase v17.2.14": fail("CONFLICT (content): src/cli.ts") },
		});

		await expect(
			runOverlayUpdate({ config: h.config, expectedVersion: "17.2.14", repoSlug: REPO_SLUG, deps: h.deps }),
		).rejects.toThrow(/conflicted; the overlay checkout was left unchanged/);

		const calls = joinedCalls(h.calls);
		expect(calls).toContain("git rebase --abort");
		expect(calls).not.toContain("bun run build");
		expect(h.installed).toEqual([]);
	});

	it("skips the rebase when the branch already contains the release tag", async () => {
		const h = harness({ table: { "git merge-base --is-ancestor": OK } });

		await runOverlayUpdate({ config: h.config, expectedVersion: "17.2.14", repoSlug: REPO_SLUG, deps: h.deps });

		const calls = joinedCalls(h.calls);
		expect(calls.some(call => call === "git -c rebase.updateRefs=false rebase v17.2.14")).toBe(false);
		expect(calls).toContain("bun run build");
		expect(h.installed).toHaveLength(1);
	});

	it("keeps the rebase but installs nothing when the build fails", async () => {
		const h = harness({ table: { "bun run build": fail("error: build failed") } });

		await expect(
			runOverlayUpdate({ config: h.config, expectedVersion: "17.2.14", repoSlug: REPO_SLUG, deps: h.deps }),
		).rejects.toThrow(/overlay binary build failed/);

		const calls = joinedCalls(h.calls);
		expect(calls).toContain("git -c rebase.updateRefs=false rebase v17.2.14");
		expect(calls).not.toContain("git rebase --abort");
		expect(h.installed).toEqual([]);
	});

	it("surfaces the undo hint with the pre-rebase commit when a later step fails", async () => {
		const h = harness({
			table: {
				"git rev-parse HEAD": out("0123456789abcdef0123456789abcdef01234567"),
				"bun install --frozen-lockfile": fail("error: lockfile mismatch"),
			},
		});

		const error = await runOverlayUpdate({
			config: h.config,
			expectedVersion: "17.2.14",
			repoSlug: REPO_SLUG,
			deps: h.deps,
		}).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(OverlayUpdateError);
		expect((error as OverlayUpdateError).hint).toContain("reset --hard 0123456789abcdef0123456789abcdef01234567");
	});

	it("fails when the build reports success but writes no binary", async () => {
		const h = harness({ existingFiles: [] });

		await expect(
			runOverlayUpdate({ config: h.config, expectedVersion: "17.2.14", repoSlug: REPO_SLUG, deps: h.deps }),
		).rejects.toThrow(/produced no binary/);
		expect(h.installed).toEqual([]);
	});

	it("rejects a path that is not a git checkout", async () => {
		const h = harness({ table: { "git rev-parse --show-toplevel": fail("not a git repository", 128) } });

		await expect(
			runOverlayUpdate({ config: h.config, expectedVersion: "17.2.14", repoSlug: REPO_SLUG, deps: h.deps }),
		).rejects.toThrow(/not a git checkout/);
	});
});
