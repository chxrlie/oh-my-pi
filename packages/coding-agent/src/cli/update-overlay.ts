/**
 * Local-overlay updates.
 *
 * A stock `omp update` replaces the installed executable with the upstream
 * release binary. That is correct for unmodified installs and wrong for anyone
 * carrying local patches — an in-tree memory backend, an experimental tool — in
 * a dev checkout: every update silently reverts the machine to stock upstream,
 * so the patch can never be dogfooded or debugged against a current release.
 *
 * The overlay path keeps the patch and the release together. Given a checkout
 * whose branch holds the local commits, the updater rebases that branch onto
 * the upstream release tag, builds a binary from the result, and installs it
 * through the same backup/verify/rollback swap the download path uses. The
 * installed binary is therefore "upstream <version> + local patches" rather
 * than either one alone.
 *
 * Safety rules that shape the code below:
 *
 * - The checkout must be clean. Uncommitted work is exactly what a rebase can
 *   strand, and an auto-stash that later fails to pop turns a routine update
 *   into data loss. Refuse instead, and say what to do.
 * - The configured branch must already be checked out. Switching branches under
 *   a user who has a working state is not the updater's call.
 * - A rebase that conflicts is aborted, leaving the checkout exactly as found.
 * - A rebase that *succeeds* is kept even if the later build fails. The rebase
 *   is the wanted state — carrying patches forward — and the build failure is
 *   the bug the user is trying to fix. The pre-rebase commit is printed so the
 *   move can still be undone deliberately.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

/** Overlay checkout to carry onto each upstream release. */
export interface OverlayConfig {
	/** Path to the git checkout holding the local patches. */
	readonly repoPath: string;
	/** Branch that must be checked out; empty accepts whatever is checked out. */
	readonly branch?: string;
	/** Remote holding upstream release tags; empty auto-detects. */
	readonly remote?: string;
}

export interface CommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs a command in `cwd` and captures its output. Injected so tests never shell out. */
export type CommandRunner = (argv: readonly string[], cwd: string) => Promise<CommandResult>;

export interface OverlayDeps {
	readonly run: CommandRunner;
	readonly log: (message: string) => void;
	/** Swaps the freshly built binary in, with backup and version verification. */
	readonly installBinary: (builtPath: string, expectedVersion: string) => Promise<void>;
	/** Overridable for tests; defaults to a real filesystem probe. */
	readonly fileExists?: (filePath: string) => Promise<boolean>;
}

/** A git remote as reported by `git remote -v`. */
export interface GitRemote {
	readonly name: string;
	readonly url: string;
}

/** Raised for every expected overlay failure so callers can print without a stack. */
export class OverlayUpdateError extends Error {
	constructor(
		message: string,
		readonly hint?: string,
	) {
		super(message);
		this.name = "OverlayUpdateError";
	}
}

/**
 * Release tag for a version. Accepts both `1.2.3` and `v1.2.3` so a caller that
 * already normalized (or did not) lands on the same ref.
 */
export function releaseTagFor(version: string): string {
	const trimmed = version.trim();
	return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

/**
 * Parse `git remote -v`. Both fetch and push lines are emitted per remote; the
 * fetch URL is the one that matters, and duplicates collapse by name.
 */
export function parseGitRemotes(stdout: string): GitRemote[] {
	const byName = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
		if (!match) continue;
		const [, name, url, kind] = match;
		if (kind === "fetch" || !byName.has(name)) byName.set(name, url);
	}
	return [...byName].map(([name, url]) => ({ name, url }));
}

/** True when a remote URL points at `owner/repo`, across ssh, https and git forms. */
export function remoteMatchesRepo(url: string, repoSlug: string): boolean {
	const normalized = url
		.replace(/\.git$/, "")
		.replace(/^git@([^:]+):/, "$1/")
		.replace(/^ssh:\/\//, "")
		.replace(/^https?:\/\//, "")
		.toLowerCase();
	return normalized.endsWith(`/${repoSlug.toLowerCase()}`);
}

/**
 * Choose the remote carrying upstream releases.
 *
 * A fork checkout has both `origin` (the fork, which does not publish release
 * tags) and `upstream`; picking by URL rather than by name keeps that case
 * right no matter what the remotes are called.
 */
export function pickOverlayRemote(remotes: readonly GitRemote[], repoSlug: string, configured?: string): string {
	if (configured) {
		if (!remotes.some(remote => remote.name === configured)) {
			throw new OverlayUpdateError(
				`overlay remote "${configured}" is not configured in the overlay checkout`,
				`known remotes: ${remotes.map(remote => remote.name).join(", ") || "(none)"}`,
			);
		}
		return configured;
	}
	const byUrl = remotes.find(remote => remoteMatchesRepo(remote.url, repoSlug));
	if (byUrl) return byUrl.name;
	const byConvention =
		remotes.find(remote => remote.name === "upstream") ?? remotes.find(remote => remote.name === "origin");
	if (byConvention) return byConvention.name;
	if (remotes.length === 1) return remotes[0].name;
	throw new OverlayUpdateError(
		`could not determine which remote of the overlay checkout tracks ${repoSlug}`,
		"set update.overlayRemote to the remote name",
	);
}

/**
 * Candidate paths the overlay build writes its executable to.
 *
 * `scripts/build-binary.ts` names the output `omp` with no extension, but a
 * Windows compile target has Bun append `.exe`, so both are accepted there and
 * the first that exists wins.
 */
export function overlayBuildOutputCandidates(repoRoot: string): string[] {
	const distDir = path.join(repoRoot, "packages", "coding-agent", "dist");
	const names = process.platform === "win32" ? ["omp.exe", "omp"] : ["omp"];
	return names.map(name => path.join(distDir, name));
}

/** Human-readable step list, printed by `omp update --check` when an overlay is configured. */
export function describeOverlayPlan(config: OverlayConfig, version: string): string[] {
	const tag = releaseTagFor(version);
	return [
		`overlay checkout: ${config.repoPath}`,
		`branch: ${config.branch || "(whatever is checked out)"}`,
		`remote: ${config.remote || "(auto-detected)"}`,
		`rebase local commits onto ${tag}, rebuild, then install the patched binary`,
	];
}

const DEFAULT_FILE_EXISTS = async (filePath: string): Promise<boolean> => {
	try {
		const stat = await fs.promises.stat(filePath);
		return stat.isFile();
	} catch {
		return false;
	}
};

/** Runs a command with Bun's shell, capturing output instead of inheriting stdio. */
export const defaultCommandRunner: CommandRunner = async (argv, cwd) => {
	try {
		const result = await $`${argv}`.cwd(cwd).quiet().nothrow();
		return {
			exitCode: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	} catch (err) {
		// An unreadable cwd or a missing binary rejects instead of exiting; keep it
		// on the result path so callers report it as an overlay failure.
		return {
			exitCode: 127,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
		};
	}
};

/** Trailing output of a failed command, trimmed to something printable. */
function failureDetail(result: CommandResult, maxLines = 12): string {
	const text = (result.stderr.trim() || result.stdout.trim()).split("\n");
	return text.slice(-maxLines).join("\n");
}

async function git(deps: OverlayDeps, cwd: string, ...args: string[]): Promise<CommandResult> {
	return await deps.run(["git", ...args], cwd);
}

async function gitOrThrow(deps: OverlayDeps, cwd: string, args: string[], message: string): Promise<string> {
	const result = await git(deps, cwd, ...args);
	if (result.exitCode !== 0) throw new OverlayUpdateError(message, failureDetail(result));
	return result.stdout.trim();
}

/** Record of the overlay build currently installed, kept beside the binary. */
export interface OverlayStamp {
	/** Release version the overlay was rebased onto. */
	readonly version: string;
	/** Overlay branch commit the installed binary was built from. */
	readonly commit: string;
}

/** What a completed overlay update produced. */
export interface OverlayUpdateResult {
	readonly branch: string;
	readonly tag: string;
	readonly commit: string;
	readonly headBefore: string;
}

/** Sidecar recording which overlay commit produced the installed binary. */
export function overlayStampPath(targetPath: string): string {
	return `${targetPath}.overlay.json`;
}

/** Reads the sidecar; a missing or corrupt stamp simply means "unknown build". */
export async function readOverlayStamp(targetPath: string): Promise<OverlayStamp | undefined> {
	try {
		const raw = await fs.promises.readFile(overlayStampPath(targetPath), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const { version, commit } = parsed as Partial<OverlayStamp>;
		if (typeof version !== "string" || typeof commit !== "string") return undefined;
		return { version, commit };
	} catch {
		return undefined;
	}
}

/** Best-effort write; losing the stamp costs a redundant rebuild, never correctness. */
export async function writeOverlayStamp(targetPath: string, stamp: OverlayStamp): Promise<void> {
	try {
		await fs.promises.writeFile(overlayStampPath(targetPath), `${JSON.stringify(stamp, null, 2)}\n`);
	} catch {}
}

/**
 * Whether the overlay must be rebuilt.
 *
 * The bug-fix loop is "commit a patch, re-run update": upstream has not moved,
 * so a version comparison alone would report "already up to date" and never
 * rebuild. Comparing the overlay's HEAD against the stamp catches that, while
 * an unchanged HEAD on an unchanged release still short-circuits.
 */
export function overlayNeedsRebuild(options: {
	stamp: OverlayStamp | undefined;
	headCommit: string | undefined;
	releaseVersion: string;
}): boolean {
	const { stamp, headCommit, releaseVersion } = options;
	if (!stamp) return true;
	if (stamp.version !== releaseVersion) return true;
	// HEAD unreadable (bad path, not a checkout): let the update run and report
	// the real error rather than silently claiming everything is current.
	if (!headCommit) return true;
	return stamp.commit !== headCommit;
}

/** Current overlay branch commit, or undefined when the checkout cannot be read. */
export async function readOverlayHeadCommit(config: OverlayConfig, run: CommandRunner): Promise<string | undefined> {
	const result = await run(["git", "rev-parse", "HEAD"], config.repoPath);
	if (result.exitCode !== 0) return undefined;
	const commit = result.stdout.trim();
	return commit.length > 0 ? commit : undefined;
}

/**
 * Rebase the overlay branch onto the upstream release, rebuild, and install.
 *
 * Throws {@link OverlayUpdateError} for every expected failure; the installed
 * binary is only touched once a build has produced a new executable.
 */
export async function runOverlayUpdate(options: {
	config: OverlayConfig;
	expectedVersion: string;
	repoSlug: string;
	deps: OverlayDeps;
}): Promise<OverlayUpdateResult> {
	const { config, expectedVersion, repoSlug, deps } = options;
	const fileExists = deps.fileExists ?? DEFAULT_FILE_EXISTS;
	const tag = releaseTagFor(expectedVersion);

	const repoRoot = await gitOrThrow(
		deps,
		config.repoPath,
		["rev-parse", "--show-toplevel"],
		`overlay path is not a git checkout: ${config.repoPath}`,
	);

	// Hard-fail on a dirty tree. Everything below rewrites the checked-out
	// commit, and uncommitted work is the one thing a rebase cannot restore.
	const status = await gitOrThrow(deps, repoRoot, ["status", "--porcelain"], "could not read overlay git status");
	if (status.length > 0) {
		throw new OverlayUpdateError(
			"overlay checkout has uncommitted changes",
			`commit or stash them in ${repoRoot} before updating — the overlay rebase would put them at risk\n${status
				.split("\n")
				.slice(0, 10)
				.join("\n")}`,
		);
	}

	const headBranch = await git(deps, repoRoot, "symbolic-ref", "--quiet", "--short", "HEAD");
	if (headBranch.exitCode !== 0) {
		throw new OverlayUpdateError(
			"overlay checkout is in detached HEAD",
			`check out the branch carrying your patches in ${repoRoot}`,
		);
	}
	const branch = headBranch.stdout.trim();
	if (config.branch && config.branch !== branch) {
		throw new OverlayUpdateError(
			`overlay checkout is on "${branch}", not the configured "${config.branch}"`,
			`run: git -C ${repoRoot} switch ${config.branch}`,
		);
	}

	const remotes = parseGitRemotes(
		await gitOrThrow(deps, repoRoot, ["remote", "-v"], "could not list overlay git remotes"),
	);
	const remote = pickOverlayRemote(remotes, repoSlug, config.remote);

	deps.log(`Fetching ${tag} from ${remote}…`);
	const fetch = await git(deps, repoRoot, "fetch", "--force", remote, `refs/tags/${tag}:refs/tags/${tag}`);
	if (fetch.exitCode !== 0) {
		throw new OverlayUpdateError(`could not fetch release tag ${tag} from ${remote}`, failureDetail(fetch));
	}

	const headBefore = await gitOrThrow(deps, repoRoot, ["rev-parse", "HEAD"], "could not read overlay HEAD");

	const alreadyRebased = await git(deps, repoRoot, "merge-base", "--is-ancestor", tag, "HEAD");
	if (alreadyRebased.exitCode === 0) {
		deps.log(`Overlay branch ${branch} already contains ${tag}`);
	} else {
		deps.log(`Rebasing ${branch} onto ${tag}…`);
		const rebase = await git(deps, repoRoot, "-c", "rebase.updateRefs=false", "rebase", tag);
		if (rebase.exitCode !== 0) {
			// Leave the checkout exactly as found; a half-applied rebase is worse
			// than no update, and the conflict is the user's call to resolve.
			await git(deps, repoRoot, "rebase", "--abort");
			throw new OverlayUpdateError(
				`rebasing ${branch} onto ${tag} conflicted; the overlay checkout was left unchanged`,
				`resolve it manually in ${repoRoot} (git rebase ${tag}), then re-run the update\n${failureDetail(rebase)}`,
			);
		}
	}

	// From here the checkout is already on the new base. Failures below keep the
	// rebase (that is the point of the overlay) and report how to undo it.
	const undoHint = `to undo the rebase: git -C ${repoRoot} reset --hard ${headBefore}`;

	deps.log("Installing overlay dependencies…");
	const install = await deps.run(["bun", "install", "--frozen-lockfile"], repoRoot);
	if (install.exitCode !== 0) {
		throw new OverlayUpdateError(
			"bun install failed in the overlay checkout",
			`${failureDetail(install)}\n${undoHint}`,
		);
	}

	deps.log("Building patched binary (this takes a few minutes)…");
	const build = await deps.run(["bun", "run", "build"], path.join(repoRoot, "packages", "coding-agent"));
	if (build.exitCode !== 0) {
		throw new OverlayUpdateError("overlay binary build failed", `${failureDetail(build)}\n${undoHint}`);
	}

	const candidates = overlayBuildOutputCandidates(repoRoot);
	let builtPath: string | undefined;
	for (const candidate of candidates) {
		if (await fileExists(candidate)) {
			builtPath = candidate;
			break;
		}
	}
	if (!builtPath) {
		throw new OverlayUpdateError(
			`overlay build reported success but produced no binary at ${candidates.join(" or ")}`,
			undoHint,
		);
	}

	try {
		await deps.installBinary(builtPath, expectedVersion);
	} catch (err) {
		throw new OverlayUpdateError(
			`installing the patched binary failed: ${err instanceof Error ? err.message : String(err)}`,
			`the built binary must report ${expectedVersion}; the rebase was kept\n${undoHint}`,
		);
	}
	const commit = await gitOrThrow(deps, repoRoot, ["rev-parse", "HEAD"], "could not read overlay HEAD after rebase");
	return { branch, tag, commit, headBefore };
}
