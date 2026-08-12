import { afterEach, describe, expect, test } from "bun:test";
import { createMineScheduler } from "@oh-my-pi/pi-coding-agent/mempalace-native/scheduler";
import type {
	MineOptions,
	MinePlan,
	MineResult,
	Miner,
	MineScheduler,
	MineSchedulerOptions,
	MineTrigger,
	Searcher,
	SearchResult,
	WakeUpContext,
} from "@oh-my-pi/pi-coding-agent/mempalace-native/types";

/**
 * The scheduler is pure policy: it never opens a file, never touches sqlite,
 * and reaches the world only through the injected `Miner`, `Searcher`, clock
 * and timer. So there is nothing here to put in a temp dir — `DIR` is just a
 * string the fake miner records and hands back.
 *
 * Nothing in this file waits on wall-clock time. The clock is a mutable
 * number, the timer is a captured callback the test fires by hand, and the
 * two places that need to observe a fire-and-forget slice await a signal the
 * code already exposes: {@link FakeMiner.entered} and {@link settle}.
 */
const DIR = "/projects/demo";
const WING = "demo";

/**
 * Wait for a slice the scheduler started on its own — the idle timer calls
 * `void requestMine("idle")`, so the test has no promise to hold.
 *
 * `requestMine` flips `running` synchronously and clears it in its `finally`,
 * so this awaits the real lifecycle rather than a guessed duration. A slice is
 * pure promise chaining with no timers or I/O, so microtask turns settle it;
 * an inert (disarmed) timer leaves `running` false and returns immediately.
 */
async function settle(scheduler: MineScheduler): Promise<void> {
	// Capped so a regression that leaves `running` set fails this test instead
	// of hanging the suite. A real slice needs a couple of dozen turns.
	for (let turn = 0; turn < 10_000; turn++) {
		if (!scheduler.state().running) return;
		await Promise.resolve();
	}
	throw new Error("scheduler never settled: a mine slice left `running` set");
}

function makePlan(overrides: Partial<MinePlan> = {}): MinePlan {
	return {
		mode: "project",
		candidateFiles: 12,
		changedFiles: 4,
		unchangedFiles: 8,
		changedBytes: 4_096,
		estimatedMillis: 800,
		truncated: false,
		...overrides,
	};
}

function makeResult(overrides: Partial<MineResult> = {}): MineResult {
	return {
		mode: "project",
		filesScanned: 4,
		filesSkipped: 0,
		filesUnchanged: 8,
		drawersCreated: 6,
		drawersUpdated: 1,
		completed: true,
		elapsedMillis: 120,
		warnings: [],
		...overrides,
	};
}

interface FakeMiner extends Miner {
	planCalls: MineOptions[];
	mineCalls: MineOptions[];
	/** Handed back by the next `plan()`; swap between calls to change the verdict. */
	nextPlan: MinePlan;
	/** Handed back by the next `mine()`, unless `pending` is set. */
	nextResult: MineResult;
	planError?: unknown;
	mineError?: unknown;
	/** When set, `mine()` blocks on this until the test settles it. */
	pending?: PromiseWithResolvers<MineResult>;
	/**
	 * Settles when `mine()` is first entered, so a test can grab the live
	 * `AbortSignal` while the slice is deliberately still in flight.
	 */
	entered: PromiseWithResolvers<MineOptions>;
	disposeCalls: number;
}

function createFakeMiner(): FakeMiner {
	const fake: FakeMiner = {
		planCalls: [],
		mineCalls: [],
		nextPlan: makePlan(),
		nextResult: makeResult(),
		entered: Promise.withResolvers<MineOptions>(),
		disposeCalls: 0,
		async plan(options) {
			fake.planCalls.push(options);
			if (fake.planError) throw fake.planError;
			return fake.nextPlan;
		},
		async mine(options) {
			fake.mineCalls.push(options);
			fake.entered.resolve(options);
			if (fake.mineError) throw fake.mineError;
			return fake.pending ? await fake.pending.promise : fake.nextResult;
		},
		async sync() {
			return { checked: 0, pruned: 0 };
		},
		dispose() {
			fake.disposeCalls++;
		},
	};
	return fake;
}

interface FakeSearcher extends Searcher {
	indexCalls: { limit: number | undefined; signal: AbortSignal | undefined }[];
	/** How many vectors the next `indexPending()` claims to have written. */
	indexed: number;
	indexError?: unknown;
}

function createFakeSearcher(): FakeSearcher {
	const fake: FakeSearcher = {
		indexCalls: [],
		indexed: 3,
		async indexPending(limit, signal) {
			fake.indexCalls.push({ limit, signal });
			if (fake.indexError) throw fake.indexError;
			return fake.indexed;
		},
		async search(): Promise<SearchResult> {
			throw new Error("the scheduler must never call search()");
		},
		async wakeUp(): Promise<WakeUpContext> {
			throw new Error("the scheduler must never call wakeUp()");
		},
	};
	return fake;
}

interface FakeSchedule {
	/** Delays handed to `schedule`, in call order. */
	delays: number[];
	/** How many armed timers were cancelled. */
	cancels: number;
	/**
	 * Invoke the most recently armed callback — cancelled or not, deliberately.
	 * A scheduler that disarms a timer must make a late callback inert on its
	 * own rather than trusting the timer host to never call back.
	 */
	fire(): void;
	schedule(fn: () => void, delayMillis: number): { cancel(): void };
}

function createFakeSchedule(): FakeSchedule {
	let latest: (() => void) | undefined;
	const fake: FakeSchedule = {
		delays: [],
		cancels: 0,
		fire() {
			latest?.();
		},
		schedule(fn, delayMillis) {
			fake.delays.push(delayMillis);
			latest = fn;
			return {
				cancel() {
					fake.cancels++;
				},
			};
		},
	};
	return fake;
}

interface Harness {
	scheduler: MineScheduler;
	miner: FakeMiner;
	searcher: FakeSearcher;
	/** Assign `clock.now` to move the injected clock; nothing here waits. */
	clock: { now: number };
	timers: FakeSchedule;
}

const liveSchedulers: MineScheduler[] = [];

afterEach(() => {
	for (const scheduler of liveSchedulers.splice(0)) scheduler.dispose();
});

function createHarness(overrides: Partial<MineSchedulerOptions> = {}, withSearcher = true): Harness {
	const miner = createFakeMiner();
	const searcher = createFakeSearcher();
	const clock = { now: 0 };
	const timers = createFakeSchedule();
	const scheduler = createMineScheduler(miner, withSearcher ? searcher : undefined, {
		dir: DIR,
		wing: WING,
		autoIngest: true,
		ingestIntervalMessages: 3,
		budgetMillis: 4_000,
		idleDelayMillis: 2_000,
		minIntervalMillis: 60_000,
		maxAutoEstimatedMillis: 120_000,
		now: () => clock.now,
		schedule: timers.schedule,
		...overrides,
	});
	liveSchedulers.push(scheduler);
	return { scheduler, miner, searcher, clock, timers };
}

describe("createMineScheduler decision policy", () => {
	test("refuses every automatic trigger when autoIngest is off, but still mines on demand", async () => {
		const h = createHarness({ autoIngest: false });
		const autoTriggers: MineTrigger[] = ["startup", "idle", "cadence"];

		for (const trigger of autoTriggers) {
			const verdict = await h.scheduler.shouldMine(trigger);
			expect(verdict.run).toBe(false);
			expect(verdict.trigger).toBe(trigger);
			expect(verdict.reason).toContain("auto-ingest");
		}
		expect(await h.scheduler.requestMine("idle")).toBeNull();
		// The refusal is free: not even the stat-only pre-flight was paid for.
		expect(h.miner.planCalls).toEqual([]);
		expect(h.miner.mineCalls).toEqual([]);

		const manual = await h.scheduler.shouldMine("manual");
		expect(manual.run).toBe(true);
		expect(await h.scheduler.requestMine("manual")).not.toBeNull();
		expect(h.miner.mineCalls).toHaveLength(1);
	});

	test("refuses a second slice while one is in flight", async () => {
		const h = createHarness();
		h.miner.pending = Promise.withResolvers<MineResult>();

		const first = h.scheduler.requestMine("manual");
		expect(h.scheduler.state().running).toBe(true);

		const verdict = await h.scheduler.shouldMine("manual");
		expect(verdict.run).toBe(false);
		expect(verdict.reason).toContain("already running");
		expect(await h.scheduler.requestMine("manual")).toBeNull();

		h.miner.pending.resolve(makeResult());
		expect(await first).not.toBeNull();
		expect(h.miner.mineCalls).toHaveLength(1);
		expect(h.scheduler.state().running).toBe(false);
	});

	test("throttles auto triggers inside the minimum interval and lets manual through", async () => {
		const h = createHarness({ minIntervalMillis: 60_000 });

		expect(await h.scheduler.requestMine("manual")).not.toBeNull();
		expect(h.scheduler.state().lastRunAt).toBe(new Date(0).toISOString());

		h.clock.now = 30_000;
		const throttled = await h.scheduler.shouldMine("idle");
		expect(throttled.run).toBe(false);
		expect(throttled.reason).toContain("60000");
		expect(await h.scheduler.requestMine("startup")).toBeNull();
		expect(h.miner.mineCalls).toHaveLength(1);

		// Manual is the escape hatch every other refusal points at.
		expect(await h.scheduler.requestMine("manual")).not.toBeNull();
		expect(h.miner.mineCalls).toHaveLength(2);

		h.clock.now = 30_000 + 60_001;
		expect(await h.scheduler.requestMine("idle")).not.toBeNull();
		expect(h.miner.mineCalls).toHaveLength(3);
	});

	test("falls back to the documented defaults when the optional knobs are omitted", async () => {
		const h = createHarness({ budgetMillis: undefined, idleDelayMillis: undefined });
		h.scheduler.noteTurnEnd();
		expect(h.timers.delays).toEqual([2_000]);

		h.timers.fire();
		await settle(h.scheduler);
		expect(h.miner.mineCalls[0]?.budgetMillis).toBe(4_000);

		const big = createHarness({ maxAutoEstimatedMillis: undefined });
		big.miner.nextPlan = makePlan({ estimatedMillis: 120_001 });
		const verdict = await big.scheduler.shouldMine("startup");
		expect(verdict.run).toBe(false);
		expect(verdict.reason).toContain("120000");
	});

	test("gates cadence triggers on turnsSinceMine and clamps a nonsensical interval", async () => {
		const h = createHarness({ ingestIntervalMessages: 3 });

		let verdict = await h.scheduler.shouldMine("cadence");
		expect(verdict.run).toBe(false);
		expect(verdict.reason).toContain("0 of 3");
		// Cadence is decided before the pre-flight, so it costs nothing.
		expect(h.miner.planCalls).toEqual([]);

		h.scheduler.noteUserTurn();
		h.scheduler.noteUserTurn();
		verdict = await h.scheduler.shouldMine("cadence");
		expect(verdict.run).toBe(false);
		expect(verdict.reason).toContain("2 of 3");

		h.scheduler.noteUserTurn();
		verdict = await h.scheduler.shouldMine("cadence");
		expect(verdict.run).toBe(true);
		expect(h.miner.planCalls).toHaveLength(1);

		// Only `cadence` is turn-gated; an idle window is not.
		const idle = createHarness({ ingestIntervalMessages: 50 });
		expect((await idle.scheduler.shouldMine("idle")).run).toBe(true);

		const clamped = createHarness({ ingestIntervalMessages: 0 });
		clamped.scheduler.noteUserTurn();
		expect((await clamped.scheduler.shouldMine("cadence")).run).toBe(true);
	});

	test("refuses a zero-change pre-flight, banks an idle streak, and widens the backoff", async () => {
		const h = createHarness({ minIntervalMillis: 1_000 });
		h.miner.nextPlan = makePlan({ changedFiles: 0, changedBytes: 0, unchangedFiles: 12, estimatedMillis: 0 });

		let verdict = await h.scheduler.shouldMine("idle");
		expect(verdict.run).toBe(false);
		expect(verdict.reason).toContain("no changed files");
		expect(verdict.plan?.candidateFiles).toBe(12);
		expect(h.scheduler.state().idleStreak).toBe(1);
		expect(h.miner.planCalls).toHaveLength(1);

		// One fruitless check doubles the floor: 1000ms -> 2000ms from the check.
		h.clock.now = 1_500;
		verdict = await h.scheduler.shouldMine("idle");
		expect(verdict.run).toBe(false);
		expect(verdict.reason).toContain("backing off");
		expect(h.miner.planCalls).toHaveLength(1);

		h.clock.now = 2_100;
		verdict = await h.scheduler.shouldMine("idle");
		expect(verdict.run).toBe(false);
		expect(verdict.reason).toContain("no changed files");
		expect(h.miner.planCalls).toHaveLength(2);
		expect(h.scheduler.state().idleStreak).toBe(2);

		// Two fruitless checks quadruple it: 4000ms from t=2100.
		h.clock.now = 4_000;
		verdict = await h.scheduler.shouldMine("idle");
		expect(verdict.reason).toContain("backing off");
		expect(h.miner.planCalls).toHaveLength(2);

		// A manual mine never waits out a backoff automatic checks earned.
		await h.scheduler.shouldMine("manual");
		expect(h.miner.planCalls).toHaveLength(3);
	});

	test("resets the idle streak and the turn counter after a productive mine", async () => {
		const h = createHarness({ minIntervalMillis: 1_000 });
		h.miner.nextPlan = makePlan({ changedFiles: 0 });
		await h.scheduler.shouldMine("idle");
		h.scheduler.noteUserTurn();
		h.scheduler.noteUserTurn();
		expect(h.scheduler.state().idleStreak).toBe(1);
		expect(h.scheduler.state().turnsSinceMine).toBe(2);

		h.miner.nextPlan = makePlan({ changedFiles: 7 });
		h.miner.nextResult = makeResult({ filesScanned: 7, drawersCreated: 9 });
		const result = await h.scheduler.requestMine("manual");

		expect(result?.drawersCreated).toBe(9);
		expect(h.scheduler.state().idleStreak).toBe(0);
		expect(h.scheduler.state().turnsSinceMine).toBe(0);
		expect(h.scheduler.state().resumePending).toBe(false);
	});

	test("refuses an oversized estimate for auto triggers but honours a manual one", async () => {
		const h = createHarness({ maxAutoEstimatedMillis: 120_000 });
		h.miner.nextPlan = makePlan({ changedFiles: 900, estimatedMillis: 450_000 });

		const auto = await h.scheduler.shouldMine("idle");
		expect(auto.run).toBe(false);
		expect(auto.reason).toContain("450000");
		expect(auto.reason).toContain("120000");
		expect(auto.plan?.changedFiles).toBe(900);
		expect(await h.scheduler.requestMine("startup")).toBeNull();
		expect(h.miner.mineCalls).toEqual([]);
		// It is a report, not a dead end, so it must not bank an idle streak.
		expect(h.scheduler.state().idleStreak).toBe(0);

		expect(await h.scheduler.requestMine("manual")).not.toBeNull();
		expect(h.miner.mineCalls).toHaveLength(1);
	});
});

describe("createMineScheduler slices", () => {
	test("arms the idle timer on turn end and mines when it fires", async () => {
		const h = createHarness({ idleDelayMillis: 2_000 });

		h.scheduler.noteTurnEnd();
		expect(h.timers.delays).toEqual([2_000]);
		expect(h.miner.mineCalls).toEqual([]);

		h.timers.fire();
		await settle(h.scheduler);

		expect(h.miner.mineCalls).toHaveLength(1);
		expect(h.miner.mineCalls[0]?.dir).toBe(DIR);
		expect(h.miner.mineCalls[0]?.wing).toBe(WING);
		expect(h.miner.mineCalls[0]?.budgetMillis).toBe(4_000);
		expect(h.scheduler.state().lastResult?.drawersCreated).toBe(6);
	});

	test("re-arming replaces the pending idle timer instead of stacking one", () => {
		const h = createHarness({ idleDelayMillis: 2_000 });

		h.scheduler.noteTurnEnd();
		h.scheduler.noteTurnEnd();

		expect(h.timers.delays).toEqual([2_000, 2_000]);
		expect(h.timers.cancels).toBe(1);
	});

	test("aborts the in-flight slice the moment a user turn starts", async () => {
		const h = createHarness();
		h.miner.pending = Promise.withResolvers<MineResult>();

		const run = h.scheduler.requestMine("manual");
		const { signal } = await h.miner.entered.promise;
		expect(signal).toBeDefined();
		expect(signal?.aborted).toBe(false);

		h.scheduler.noteUserTurn();

		expect(signal?.aborted).toBe(true);
		expect(h.scheduler.state().turnsSinceMine).toBe(1);

		// Even a slice that manages to report success after the abort must not
		// kick off the embedding backlog — the user's turn owns the CPU now.
		h.miner.pending.resolve(makeResult({ completed: true }));
		await run;
		expect(h.searcher.indexCalls).toEqual([]);
		expect(h.scheduler.state().running).toBe(false);
	});

	test("disarms the pending idle timer when a user turn starts", async () => {
		const h = createHarness();

		h.scheduler.noteTurnEnd();
		expect(h.timers.delays).toHaveLength(1);

		h.scheduler.noteUserTurn();
		expect(h.timers.cancels).toBe(1);

		// A disarmed timer that fires anyway must be inert. A live callback would
		// flip `running` synchronously, so this catches it either way.
		h.timers.fire();
		expect(h.scheduler.state().running).toBe(false);
		await settle(h.scheduler);
		expect(h.miner.planCalls).toEqual([]);
		expect(h.miner.mineCalls).toEqual([]);
	});

	test("marks resumePending on a truncated run and resumes on the next idle window", async () => {
		const h = createHarness({ minIntervalMillis: 1_000, idleDelayMillis: 2_000 });
		h.miner.nextResult = makeResult({ completed: false, filesScanned: 2 });

		expect(await h.scheduler.requestMine("manual")).not.toBeNull();
		expect(h.scheduler.state().resumePending).toBe(true);

		// Known work left, pre-flight already paid for: skip the quiet period.
		h.scheduler.noteTurnEnd();
		expect(h.timers.delays).toEqual([0]);

		h.clock.now = 5_000;
		h.miner.nextResult = makeResult({ completed: true });
		h.timers.fire();
		await settle(h.scheduler);

		expect(h.miner.mineCalls).toHaveLength(2);
		expect(h.scheduler.state().resumePending).toBe(false);
		expect(h.scheduler.state().turnsSinceMine).toBe(0);

		// Back to a normal quiet period once there is nothing left to resume.
		h.scheduler.noteTurnEnd();
		expect(h.timers.delays).toEqual([0, 2_000]);
	});

	test("indexes pending vectors after a completed slice, under the same controller", async () => {
		const h = createHarness();

		expect(await h.scheduler.requestMine("manual")).not.toBeNull();

		expect(h.searcher.indexCalls).toHaveLength(1);
		expect(h.searcher.indexCalls[0]?.signal).toBe(h.miner.mineCalls[0]?.signal);
	});

	test("skips indexing after a truncated slice", async () => {
		const h = createHarness();
		h.miner.nextResult = makeResult({ completed: false });

		expect(await h.scheduler.requestMine("manual")).not.toBeNull();

		expect(h.miner.mineCalls).toHaveLength(1);
		expect(h.searcher.indexCalls).toEqual([]);
	});

	test("mines happily with no searcher configured", async () => {
		const h = createHarness({}, false);

		expect(await h.scheduler.requestMine("manual")).not.toBeNull();
		expect(h.searcher.indexCalls).toEqual([]);
	});

	test("yields null instead of throwing when the miner rejects", async () => {
		const h = createHarness();
		h.miner.mineError = new Error("mine worker died");

		expect(await h.scheduler.requestMine("manual")).toBeNull();
		expect(h.scheduler.state().running).toBe(false);
		expect(h.searcher.indexCalls).toEqual([]);

		// The failure must not wedge the scheduler.
		h.miner.mineError = undefined;
		expect(await h.scheduler.requestMine("manual")).not.toBeNull();
	});

	test("yields null instead of throwing when the searcher rejects", async () => {
		const h = createHarness();
		h.searcher.indexError = new Error("embeddings unavailable");

		expect(await h.scheduler.requestMine("manual")).toBeNull();
		// The mine itself landed; only the embedding backlog failed.
		expect(h.scheduler.state().lastResult?.completed).toBe(true);
		expect(h.scheduler.state().running).toBe(false);
	});

	test("degrades to a refusal when the pre-flight rejects", async () => {
		const h = createHarness();
		h.miner.planError = new Error("stat storm");

		const verdict = await h.scheduler.shouldMine("manual");
		expect(verdict.run).toBe(false);
		expect(verdict.reason).toContain("pre-flight failed");
		// A wedged miner backs off rather than being re-probed every window.
		expect(h.scheduler.state().idleStreak).toBe(1);

		expect(await h.scheduler.requestMine("manual")).toBeNull();
		expect(h.miner.mineCalls).toEqual([]);
	});
});

describe("createMineScheduler lifecycle", () => {
	test("state() hands back a snapshot that neither side can mutate", async () => {
		const h = createHarness();
		h.miner.nextResult = makeResult({ warnings: ["skipped a symlink"] });
		await h.scheduler.requestMine("manual");

		const snapshot = h.scheduler.state();
		expect(snapshot.turnsSinceMine).toBe(0);
		expect(snapshot.lastRunAt).toBe(new Date(0).toISOString());
		expect(snapshot.lastResult?.warnings).toEqual(["skipped a symlink"]);
		expect(snapshot.lastDecision?.plan?.changedFiles).toBe(4);

		// Writing through the snapshot must not reach the scheduler...
		snapshot.turnsSinceMine = 99;
		snapshot.idleStreak = 42;
		snapshot.lastResult?.warnings.push("forged");
		if (snapshot.lastDecision?.plan) snapshot.lastDecision.plan.changedFiles = 999;

		// ...and later activity must not rewrite what the caller was handed.
		h.scheduler.noteUserTurn();

		expect(snapshot.turnsSinceMine).toBe(99);
		const fresh = h.scheduler.state();
		expect(fresh.turnsSinceMine).toBe(1);
		expect(fresh.idleStreak).toBe(0);
		expect(fresh.lastResult?.warnings).toEqual(["skipped a symlink"]);
		expect(fresh.lastDecision?.plan?.changedFiles).toBe(4);
		expect(fresh.lastResult).not.toBe(snapshot.lastResult);
		expect(fresh.lastDecision).not.toBe(snapshot.lastDecision);
	});

	test("cancel() aborts the in-flight slice and disarms the idle timer", async () => {
		const h = createHarness();
		h.miner.pending = Promise.withResolvers<MineResult>();

		const run = h.scheduler.requestMine("manual");
		const { signal } = await h.miner.entered.promise;
		h.scheduler.noteTurnEnd();
		expect(h.timers.delays).toHaveLength(1);

		h.scheduler.cancel();

		expect(signal?.aborted).toBe(true);
		expect(h.timers.cancels).toBe(1);

		h.miner.pending.resolve(makeResult({ completed: false }));
		await run;
		expect(h.scheduler.state().running).toBe(false);
	});

	test("dispose() is idempotent and stops all further work", async () => {
		const h = createHarness();
		h.miner.pending = Promise.withResolvers<MineResult>();

		const run = h.scheduler.requestMine("manual");
		const { signal } = await h.miner.entered.promise;

		h.scheduler.dispose();
		h.scheduler.dispose();
		expect(signal?.aborted).toBe(true);

		h.miner.pending.resolve(makeResult({ completed: false }));
		await run;

		h.scheduler.noteTurnEnd();
		expect(h.timers.delays).toEqual([]);
		h.scheduler.noteUserTurn();
		expect(h.scheduler.state().turnsSinceMine).toBe(0);

		expect(await h.scheduler.requestMine("manual")).toBeNull();
		const verdict = await h.scheduler.shouldMine("manual");
		expect(verdict.run).toBe(false);
		expect(verdict.reason).toContain("disposed");
		expect(h.miner.mineCalls).toHaveLength(1);

		// The scheduler does not own the miner, so it must not dispose it.
		expect(h.miner.disposeCalls).toBe(0);
	});
});
