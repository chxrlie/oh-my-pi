import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { createMineWorkerHandle } from "./mine-client";
import type {
	CreateMiner,
	DrawerInput,
	DrawerWriteResult,
	MinedFilePayload,
	MineMode,
	MineOptions,
	MinePlan,
	MineResult,
	MineRunSummary,
	Miner,
	MinerOptions,
	MineWorkerHandle,
	MineWorkerPlanRequest,
	MineWorkerRunRequest,
	SyncOptions,
	SyncResult,
	Vault,
} from "./types";

/**
 * Ingest. The miner owns none of the expensive work: the walk, the reads, the
 * hashing and the chunking all happen in the mine subprocess. What lives here
 * is the part that needs the vault — diffing the incremental ledger, deciding
 * how to interpret the target directory, filing the drawers a streamed file
 * produced, and pruning drawers whose source file is gone.
 *
 * Every entry point degrades instead of throwing. A vanished directory, an
 * unavailable worker, a vault that refuses a write: each becomes a zero (or
 * partial) result plus a warning, because mining is background work that must
 * never be able to fault an agent turn.
 */

/** Matches `MineOptions.maxFileBytes`'s documented default. */
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
/** Matches `MineOptions.maxFiles`'s documented default. */
const DEFAULT_MAX_FILES = 2000;
/** `MineResult.warnings` is a diagnostic tail, not a log; keep it bounded. */
const MAX_WARNINGS = 20;

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Fall back to `fallback` for anything that is not a usable positive count, so
 * a `0` or a `NaN` from a settings round-trip cannot silently disable the walk.
 */
function positiveOr(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Decide how to read the target tree. Load-bearing: mining harness session logs
 * in `project` mode chunks raw JSONL transcripts as if they were source and
 * floods the palace with noise, so anything at or under the sessions root is
 * `convos`. The separator-anchored prefix test is deliberate — a plain
 * `startsWith` would drag a sibling like `<sessions>-archive` in with it.
 */
function detectMode(resolvedDir: string, explicit: MineMode | undefined, sessionsDir: string | undefined): MineMode {
	if (explicit) return explicit;
	if (!sessionsDir) return "project";
	const root = path.resolve(sessionsDir);
	if (resolvedDir === root) return "convos";
	const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
	return resolvedDir.startsWith(prefix) ? "convos" : "project";
}

class NativeMiner implements Miner {
	#vault: Vault;
	#options: MinerOptions;
	#worker: MineWorkerHandle | null = null;
	#released = false;

	constructor(vault: Vault, options: MinerOptions) {
		this.#vault = vault;
		this.#options = options;
	}

	async plan(options: MineOptions): Promise<MinePlan> {
		const dir = this.#resolveDir(options.dir);
		const mode = detectMode(dir, options.mode, this.#sessionsRoot(options));
		const empty: MinePlan = {
			mode,
			candidateFiles: 0,
			changedFiles: 0,
			unchangedFiles: 0,
			changedBytes: 0,
			estimatedMillis: 0,
			truncated: false,
		};
		if (!(await this.#isMineable(dir))) return empty;
		const worker = this.#ensureWorker();
		if (!worker) return empty;
		try {
			return (await worker.plan(this.#planRequest(dir, mode, options))) ?? empty;
		} catch (error) {
			logger.warn("mempalace-mine: plan failed", { dir, error: describeError(error) });
			return empty;
		}
	}

	async mine(options: MineOptions): Promise<MineResult> {
		const startedAt = Date.now();
		const dir = this.#resolveDir(options.dir);
		const mode = detectMode(dir, options.mode, this.#sessionsRoot(options));
		const nothing = (warning: string): MineResult => ({
			mode,
			filesScanned: 0,
			filesSkipped: 0,
			filesUnchanged: 0,
			drawersCreated: 0,
			drawersUpdated: 0,
			completed: false,
			elapsedMillis: Date.now() - startedAt,
			warnings: [warning],
		});

		if (!(await this.#isMineable(dir))) return nothing(`mine target is not a directory: ${dir}`);
		if (options.signal?.aborted) return nothing("mine aborted before it started");
		const worker = this.#ensureWorker();
		if (!worker) return nothing("mine worker unavailable");

		const request: MineWorkerRunRequest = {
			...this.#planRequest(dir, mode, options),
			budgetMillis: positiveOr(options.budgetMillis, 0),
		};
		const warnings: string[] = [];
		let drawersCreated = 0;
		let drawersUpdated = 0;
		let summary: MineRunSummary | null = null;
		try {
			summary = await worker.run(request, file => {
				// Throwing is the cancel channel: the client turns a rejected
				// `onFile` into a `cancel` for the child, so an abort stops the
				// walk at the next file boundary instead of only at the end.
				options.signal?.throwIfAborted();
				const written = this.#persist(options.wing, mode, file, warnings);
				drawersCreated += written.created;
				drawersUpdated += written.updated;
			});
		} catch (error) {
			// The handle is contractually non-throwing, but an injected one may
			// not be; whatever streamed before the fault is still real.
			this.#warn(warnings, `mine run failed: ${describeError(error)}`);
			logger.warn("mempalace-mine: run failed", { dir, error: describeError(error) });
		}
		return {
			mode,
			filesScanned: summary?.filesScanned ?? 0,
			filesSkipped: summary?.filesSkipped ?? 0,
			filesUnchanged: summary?.filesUnchanged ?? 0,
			drawersCreated,
			drawersUpdated,
			// An abort truncates the walk even if the child managed to report a
			// tidy `done` for the slice it had already finished.
			completed: (summary?.completed ?? false) && !options.signal?.aborted,
			elapsedMillis: Date.now() - startedAt,
			warnings: [...(summary?.warnings ?? []), ...warnings].slice(0, MAX_WARNINGS),
		};
	}

	/**
	 * Drop drawers whose source file no longer exists. Stat-only by design: this
	 * runs far more often than a mine and must stay cheap enough to be free.
	 * Forgetting the ledger row alongside the drawers is what lets a file that
	 * comes back — a revert, a branch switch — re-mine cleanly.
	 */
	async sync(options: SyncOptions = {}): Promise<SyncResult> {
		let sourcePaths: string[];
		try {
			sourcePaths = this.#vault.knownSourcePaths(options.wing);
		} catch (error) {
			logger.warn("mempalace-mine: sync could not list source paths", { error: describeError(error) });
			return { checked: 0, pruned: 0 };
		}
		let checked = 0;
		let pruned = 0;
		for (const sourcePath of sourcePaths) {
			if (options.signal?.aborted) break;
			checked += 1;
			if (
				await fs.promises
					.access(sourcePath)
					.then(() => true)
					.catch(() => false)
			)
				continue;
			try {
				pruned += this.#vault.deleteBySource(sourcePath);
				this.#vault.forgetMinedFile(sourcePath);
			} catch (error) {
				logger.warn("mempalace-mine: sync could not prune a vanished source", {
					sourcePath,
					error: describeError(error),
				});
			}
		}
		return { checked, pruned };
	}

	dispose(): void {
		const worker = this.#worker;
		this.#worker = null;
		this.#released = true;
		try {
			worker?.dispose();
		} catch (error) {
			logger.debug("mempalace-mine: worker dispose failed", { error: describeError(error) });
		}
	}

	#resolveDir(dir: string): string {
		return path.isAbsolute(dir) ? path.resolve(dir) : path.resolve(this.#options.cwd, dir);
	}

	/** A per-call sessions root wins over the injected one; both are optional. */
	#sessionsRoot(options: MineOptions): string | undefined {
		if (options.sessionsDir) return options.sessionsDir;
		try {
			return this.#options.sessionsDir?.();
		} catch (error) {
			logger.debug("mempalace-mine: sessions dir lookup failed", { error: describeError(error) });
			return undefined;
		}
	}

	async #isMineable(dir: string): Promise<boolean> {
		try {
			const stat = await fs.promises.stat(dir);
			if (stat.isDirectory()) return true;
		} catch {
			// Missing, unreadable, or a dangling symlink — all the same to us.
		}
		logger.warn("mempalace-mine: target is not a directory", { dir });
		return false;
	}

	/** Spawned lazily and at most once per miner; `dispose()` is final. */
	#ensureWorker(): MineWorkerHandle | null {
		if (this.#released) return null;
		if (this.#worker) return this.#worker;
		try {
			this.#worker = (this.#options.spawnWorker ?? createMineWorkerHandle)();
		} catch (error) {
			logger.warn("mempalace-mine: worker spawn failed; mining disabled", { error: describeError(error) });
			this.#released = true;
			return null;
		}
		return this.#worker;
	}

	#planRequest(dir: string, mode: MineMode, options: MineOptions): MineWorkerPlanRequest {
		return {
			dir,
			mode,
			maxFileBytes: positiveOr(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
			maxFiles: positiveOr(options.maxFiles, DEFAULT_MAX_FILES),
			ledger: this.#ledger(options.wing),
			force: options.force ?? false,
		};
	}

	/**
	 * Flatten the ledger for transport. `size:mtimeMs` is all the child needs to
	 * prove a candidate unchanged, and it keeps the payload a fraction of the
	 * size of the full records — this crosses IPC on every plan and every run.
	 */
	#ledger(wing: string): Record<string, string> {
		const ledger: Record<string, string> = {};
		try {
			for (const [minedPath, record] of this.#vault.getMinedFiles(wing)) {
				ledger[minedPath] = `${record.size}:${record.mtimeMs}`;
			}
		} catch (error) {
			// An unreadable ledger costs a full re-mine, not a failure.
			logger.warn("mempalace-mine: ledger read failed; mining everything", {
				wing,
				error: describeError(error),
			});
		}
		return ledger;
	}

	/** File one streamed file's chunks, then stamp the ledger row it earned. */
	#persist(
		wing: string,
		mode: MineMode,
		file: MinedFilePayload,
		warnings: string[],
	): { created: number; updated: number } {
		const basename = path.basename(file.path);
		const inputs: DrawerInput[] = file.chunks.map(chunk => ({
			wing,
			room: file.room,
			title: `${basename} — ${chunk.title}`,
			content: chunk.body,
			source: mode === "convos" ? "convo" : "mine",
			sourcePath: file.path,
			origin: mode === "convos" ? "convo" : "mined",
			addedBy: "omp",
		}));

		let results: DrawerWriteResult[];
		try {
			results = this.#vault.addDrawers(inputs);
		} catch (error) {
			this.#warn(warnings, `failed to file drawers for ${file.path}: ${describeError(error)}`);
			return { created: 0, updated: 0 };
		}
		// The vault rolls the whole batch back and returns `[]` when sqlite
		// refuses it. Nothing was persisted, so the ledger must not claim this
		// file was mined — that would skip it as unchanged on the next run.
		if (inputs.length > 0 && results.length === 0) {
			this.#warn(warnings, `drawer batch rolled back for ${file.path}`);
			return { created: 0, updated: 0 };
		}
		let created = 0;
		let updated = 0;
		for (const result of results) {
			if (result.created) created += 1;
			if (result.updated) updated += 1;
		}

		try {
			this.#vault.recordMinedFile({
				path: file.path,
				wing,
				size: file.size,
				mtimeMs: file.mtimeMs,
				contentHash: file.contentHash,
				minedAt: new Date().toISOString(),
				drawerCount: file.chunks.length,
			});
		} catch (error) {
			this.#warn(warnings, `failed to record ${file.path} in the ledger: ${describeError(error)}`);
		}
		return { created, updated };
	}

	/** Record a non-fatal problem for the caller, and always for the log. */
	#warn(warnings: string[], message: string): void {
		logger.debug("mempalace-mine: mine warning", { message });
		if (warnings.length < MAX_WARNINGS) warnings.push(message);
	}
}

/**
 * Build the ingest surface over a vault. The worker is not spawned here — the
 * first `plan` or `mine` does that — so a session that never mines pays nothing
 * for having a miner.
 */
export const createMiner: CreateMiner = (vault, options) => new NativeMiner(vault, options);
