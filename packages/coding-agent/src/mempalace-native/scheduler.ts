/**
 * Smart Mining: the governor that decides *whether* to mine.
 *
 * Mining is the process-intensive half of the native palace — a directory
 * walk, a read and a SHA-256 per candidate file, chunking, then vector
 * writes. Left to its own devices it would happily burn seconds of CPU in
 * the middle of a user's turn. Nothing here does any of that work; this
 * module only decides when the miner is allowed to, and bounds it when it is:
 *
 *   - nothing runs unless `autoIngest` is on, or the user asked explicitly;
 *   - at most one slice is ever in flight;
 *   - a hard floor (`minIntervalMillis`) sits between consecutive runs, with
 *     an exponential backoff stacked on top once evaluations stop finding
 *     work, so a quiet repo settles into probing every sixteen floors rather
 *     than every one;
 *   - a stat-only pre-flight (`miner.plan`) prices the work before a single
 *     byte is read, and an estimate over `maxAutoEstimatedMillis` is reported
 *     rather than run — the user gets to choose to pay it;
 *   - the work itself runs in bounded slices under an `AbortController` the
 *     scheduler owns, and `noteUserTurn` trips that controller the instant a
 *     turn begins. The user's turn always wins; that is the whole feature.
 *
 * Every clock read and every timer goes through injected `options.now` and
 * `options.schedule`, so the policy is exercisable without real delays.
 *
 * Nothing here throws. A miner that rejects, a searcher that rejects, a
 * pre-flight that explodes: each is logged and degrades to "did not mine".
 * A misconfigured memory store must never break an agent turn.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type {
	CreateMineScheduler,
	IsoTimestamp,
	MineDecision,
	MinePlan,
	MineResult,
	MineScheduler,
	MineSchedulerState,
	MineTrigger,
} from "./types";

const DEFAULT_INGEST_INTERVAL_MESSAGES = 15;
const DEFAULT_BUDGET_MILLIS = 4_000;
const DEFAULT_IDLE_DELAY_MILLIS = 2_000;
const DEFAULT_MIN_INTERVAL_MILLIS = 60_000;
const DEFAULT_MAX_AUTO_ESTIMATED_MILLIS = 120_000;

/**
 * The backoff doubles per fruitless evaluation and stops here, so a repo that
 * never changes is probed every `minIntervalMillis * 16` instead of drifting
 * towards never being probed again.
 */
const MAX_BACKOFF_DOUBLINGS = 4;

/** Accept a caller-supplied millisecond option, ignoring anything nonsensical. */
function millisOption(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Real timer, `unref`'d so a pending idle mine never holds the process open. */
function defaultSchedule(fn: () => void, delayMillis: number): { cancel(): void } {
	const timer = setTimeout(fn, delayMillis);
	timer.unref?.();
	return {
		cancel: () => clearTimeout(timer),
	};
}

export const createMineScheduler: CreateMineScheduler = (miner, searcher, options) => {
	const { dir, wing } = options;
	const now = options.now ?? Date.now;
	const schedule = options.schedule ?? defaultSchedule;
	const autoIngest = options.autoIngest === true;
	// A zero or negative cadence would mean "mine every single turn", which is
	// the opposite of what this whole module exists to prevent.
	const ingestIntervalMessages = Number.isFinite(options.ingestIntervalMessages)
		? Math.max(1, Math.floor(options.ingestIntervalMessages))
		: DEFAULT_INGEST_INTERVAL_MESSAGES;
	const budgetMillis = millisOption(options.budgetMillis, DEFAULT_BUDGET_MILLIS);
	const idleDelayMillis = millisOption(options.idleDelayMillis, DEFAULT_IDLE_DELAY_MILLIS);
	const minIntervalMillis = millisOption(options.minIntervalMillis, DEFAULT_MIN_INTERVAL_MILLIS);
	const maxAutoEstimatedMillis = millisOption(options.maxAutoEstimatedMillis, DEFAULT_MAX_AUTO_ESTIMATED_MILLIS);

	let running = false;
	let disposed = false;
	let turnsSinceMine = 0;
	let idleStreak = 0;
	let resumePending = false;
	let lastResult: MineResult | undefined;
	let lastDecision: MineDecision | undefined;
	/** When a slice last actually ran. Drives the `minIntervalMillis` floor. */
	let lastRunAtMillis: number | undefined;
	/**
	 * When a pre-flight was last paid for, run or not. The backoff measures from
	 * here rather than from `lastRunAtMillis`, because the thing it suppresses is
	 * the repeated stat walk of a tree that never changes.
	 */
	let lastCheckAtMillis: number | undefined;
	let slice: AbortController | undefined;
	let idleTimer: { cancel(): void } | undefined;
	/** Bumped on every disarm so a cancelled timer that still fires stays inert. */
	let idleGeneration = 0;

	function remember(decision: MineDecision): MineDecision {
		lastDecision = decision;
		return decision;
	}

	/**
	 * The policy, in priority order. `claimed` is set by {@link requestMine},
	 * which flips `running` before it awaits anything and would otherwise refuse
	 * itself at the concurrency gate.
	 */
	async function evaluate(trigger: MineTrigger, claimed: boolean): Promise<MineDecision> {
		const manual = trigger === "manual";
		if (disposed) return remember({ run: false, reason: "scheduler is disposed", trigger });

		if (!autoIngest && !manual) {
			return remember({ run: false, reason: "auto-ingest is off; mine manually to ingest", trigger });
		}

		if (running && !claimed) {
			return remember({ run: false, reason: "a mine slice is already running", trigger });
		}

		if (!manual && lastRunAtMillis !== undefined) {
			const sinceRun = now() - lastRunAtMillis;
			if (sinceRun < minIntervalMillis) {
				const reason = `last run was ${Math.round(sinceRun)}ms ago, under the ${minIntervalMillis}ms floor`;
				return remember({ run: false, reason, trigger });
			}
		}

		if (trigger === "cadence" && turnsSinceMine < ingestIntervalMessages) {
			const reason = `${turnsSinceMine} of ${ingestIntervalMessages} turns since the last mine`;
			return remember({ run: false, reason, trigger });
		}

		// A manual mine is the escape hatch every other refusal points at, so it
		// never waits out a backoff that fruitless *automatic* checks earned.
		if (!manual && idleStreak > 0 && lastCheckAtMillis !== undefined) {
			const backoffMillis = minIntervalMillis * 2 ** Math.min(idleStreak, MAX_BACKOFF_DOUBLINGS);
			const sinceCheck = now() - lastCheckAtMillis;
			if (sinceCheck < backoffMillis) {
				const left = Math.round(backoffMillis - sinceCheck);
				const reason = `backing off after ${idleStreak} fruitless checks: ${left}ms left of ${backoffMillis}ms`;
				return remember({ run: false, reason, trigger });
			}
		}

		// Everything above is free. From here on we spend a stat walk.
		lastCheckAtMillis = now();
		let plan: MinePlan;
		try {
			plan = await miner.plan({ dir, wing, signal: slice?.signal });
		} catch (err) {
			const message = errorText(err);
			logger.warn("mempalace-native: mine pre-flight failed", { dir, wing, trigger, error: message });
			// Treat a broken pre-flight as fruitless so a wedged miner backs off
			// instead of being re-probed on every idle window.
			idleStreak++;
			return remember({ run: false, reason: `pre-flight failed: ${message}`, trigger });
		}

		if (plan.changedFiles === 0) {
			idleStreak++;
			return remember({ run: false, reason: `pre-flight found no changed files under ${dir}`, trigger, plan });
		}

		if (!manual && plan.estimatedMillis > maxAutoEstimatedMillis) {
			const reason =
				`estimated ${plan.estimatedMillis}ms for ${plan.changedFiles} changed files exceeds the ` +
				`${maxAutoEstimatedMillis}ms auto limit; mine manually to run it`;
			return remember({ run: false, reason, trigger, plan });
		}

		const reason = `${plan.changedFiles} changed files, estimated ${plan.estimatedMillis}ms`;
		return remember({ run: true, reason, trigger, plan });
	}

	function shouldMine(trigger: MineTrigger): Promise<MineDecision> {
		return evaluate(trigger, false);
	}

	async function requestMine(trigger: MineTrigger): Promise<MineResult | null> {
		if (disposed) return null;
		if (running) {
			remember({ run: false, reason: "a mine slice is already running", trigger });
			return null;
		}

		// Claim synchronously. `evaluate` awaits the pre-flight, so a claim taken
		// any later would let two concurrent callers both past the concurrency
		// gate and start two slices over the same tree.
		running = true;
		const controller = new AbortController();
		slice = controller;
		let started = false;
		try {
			const decision = await evaluate(trigger, true);
			if (!decision.run) return null;
			if (controller.signal.aborted) {
				logger.debug("mempalace-native: mine aborted before the slice started", { trigger });
				return null;
			}

			started = true;
			const result = await miner.mine({ dir, wing, budgetMillis, signal: controller.signal });
			lastResult = result;
			resumePending = result.completed === false;
			if (result.completed) turnsSinceMine = 0;
			// A slice that touched nothing keeps widening the backoff; one that
			// mined something proves the tree is live again.
			const moved = result.filesScanned > 0 || result.drawersCreated > 0 || result.drawersUpdated > 0;
			idleStreak = moved ? 0 : idleStreak + 1;

			// Embedding the backlog is the other expensive half, so it runs under
			// the same controller and is skipped outright once the slice is dead.
			if (result.completed && searcher && !controller.signal.aborted) {
				const indexed = await searcher.indexPending(undefined, controller.signal);
				if (indexed > 0) logger.debug("mempalace-native: indexed pending vectors", { wing, indexed });
			}
			return result;
		} catch (err) {
			logger.warn("mempalace-native: mine slice failed", { dir, wing, trigger, error: errorText(err) });
			return null;
		} finally {
			// Only a slice that really started moves the floor; a refusal costs
			// nothing and must not throttle the next honest attempt.
			if (started) lastRunAtMillis = now();
			if (slice === controller) slice = undefined;
			running = false;
		}
	}

	function disarmIdle(): void {
		const pending = idleTimer;
		idleTimer = undefined;
		idleGeneration++;
		if (!pending) return;
		try {
			pending.cancel();
		} catch (err) {
			logger.debug("mempalace-native: idle timer cancel failed", { error: errorText(err) });
		}
	}

	function armIdle(delayMillis: number): void {
		disarmIdle();
		const generation = idleGeneration;
		try {
			idleTimer = schedule(() => {
				if (generation !== idleGeneration) return;
				idleTimer = undefined;
				void requestMine("idle");
			}, delayMillis);
		} catch (err) {
			idleTimer = undefined;
			logger.warn("mempalace-native: could not arm the idle mine timer", { error: errorText(err) });
		}
	}

	function cancel(): void {
		if (slice && !slice.signal.aborted) slice.abort();
		disarmIdle();
	}

	function noteUserTurn(): void {
		if (disposed) return;
		turnsSinceMine++;
		// The user's turn always wins. Kill the slice now, not at the next file
		// boundary, and drop any idle window that was about to open.
		cancel();
	}

	function noteTurnEnd(): void {
		if (disposed) return;
		// A budget-truncated run has known work left and has already paid for its
		// pre-flight, so it skips the quiet period and finishes across successive
		// idle windows instead of restarting the wait each time.
		armIdle(resumePending ? 0 : idleDelayMillis);
	}

	function state(): MineSchedulerState {
		let lastRunAt: IsoTimestamp | undefined;
		if (lastRunAtMillis !== undefined) {
			// An injected clock is not obliged to hand back a plausible epoch.
			const at = new Date(lastRunAtMillis);
			lastRunAt = Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
		}
		// A snapshot, not a window: callers must not reach in and mutate scheduler
		// state, and later activity must not rewrite what they were handed.
		const result = lastResult ? { ...lastResult, warnings: [...(lastResult.warnings ?? [])] } : undefined;
		const decision = lastDecision
			? { ...lastDecision, plan: lastDecision.plan ? { ...lastDecision.plan } : undefined }
			: undefined;
		return {
			running,
			turnsSinceMine,
			idleStreak,
			resumePending,
			lastRunAt,
			lastResult: result,
			lastDecision: decision,
		};
	}

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		cancel();
		// The counters and the last result stay readable: a post-dispose `status`
		// should still be able to say what the session's mining actually did.
	}

	const scheduler: MineScheduler = {
		noteUserTurn,
		noteTurnEnd,
		shouldMine,
		requestMine,
		cancel,
		state,
		dispose,
	};
	return scheduler;
};
