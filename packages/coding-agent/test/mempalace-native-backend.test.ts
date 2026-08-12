/**
 * Behavioural contract for the native MemPalace backend.
 *
 * The vault is real — `openVault` against a throwaway sqlite file in a temp
 * dir — because dedup, FTS matching and the diary/drawer split are exactly what
 * these tests are about, and a faked vault would assert nothing. Embeddings are
 * switched off in every harness so search stays lexical, deterministic, and
 * free of any worker process.
 *
 * Where a collaborator only needs to be *observed* rather than exercised (the
 * scheduler's turn counting, the enqueue trigger, the mine call), the test
 * hand-rolls a stub satisfying the interface from `types.ts`. That keeps the
 * assertion on this module's wiring instead of a sibling's internals, and keeps
 * mining — which spawns a subprocess in production — out of the test run.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MemoryBackendStartOptions } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import {
	MempalaceNativeSessionState,
	mempalaceNativeBackend,
} from "@oh-my-pi/pi-coding-agent/mempalace-native/backend";
import { loadMempalaceNativeConfig } from "@oh-my-pi/pi-coding-agent/mempalace-native/config";
import { DEFAULT_MEMPALACE_EMBED_MODEL } from "@oh-my-pi/pi-coding-agent/mempalace-native/embed";
import {
	getMempalaceNativeSessionState,
	setMempalaceNativeSessionState,
} from "@oh-my-pi/pi-coding-agent/mempalace-native/state";
import type {
	MineOptions,
	Miner,
	MineScheduler,
	MineTrigger,
	Searcher,
} from "@oh-my-pi/pi-coding-agent/mempalace-native/types";
import { openVault, wingNameFor } from "@oh-my-pi/pi-coding-agent/mempalace-native/vault";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const tempDirs: string[] = [];
const openStates: MempalaceNativeSessionState[] = [];

afterEach(() => {
	for (const state of openStates.splice(0)) state.dispose();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/**
 * `Settings` is a schema-bound class and `mempalaceNative.*` is not in its
 * schema yet, so `Settings.isolated` cannot even name these keys. The loader
 * only ever calls `get(path)`, so a map-backed stub is the entire surface — and
 * it exercises the same "unregistered key" path production sees until the
 * schema entries land.
 */
function fakeSettings(values: Record<string, unknown> = {}): Settings {
	const stub = { get: (key: string) => values[key] };
	return stub as unknown as Settings;
}

/** `start` never reads the registry; the native palace has no remote models. */
const NO_MODEL_REGISTRY = {} as unknown as ModelRegistry;

/** The subset of an `AgentSession` that `start` and the turn hook actually touch. */
interface FakeEvent {
	type: string;
	isTerminal?: boolean;
}

interface FakeSession {
	sessionId: string;
	settings: Settings;
	sessionManager: { getCwd(): string };
	subscribe(listener: (event: FakeEvent) => void): () => void;
	emit(event: FakeEvent): void;
	listenerCount(): number;
}

function fakeSession(cwd: string, settings: Settings): FakeSession {
	const listeners = new Set<(event: FakeEvent) => void>();
	return {
		sessionId: "mempalace-native-test",
		settings,
		sessionManager: { getCwd: () => cwd },
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(event) {
			for (const listener of [...listeners]) listener(event);
		},
		listenerCount: () => listeners.size,
	};
}

interface Harness {
	agentDir: string;
	cwd: string;
	wing: string;
	dbPath: string;
	session: FakeSession;
	agentSession: AgentSession;
	context: { agentDir: string; cwd: string; session: AgentSession };
	attached(): MempalaceNativeSessionState | undefined;
}

async function startBackend(
	options: { settings?: Record<string, unknown>; taskDepth?: number; agentDir?: string; cwd?: string } = {},
): Promise<Harness> {
	const agentDir = options.agentDir ?? makeTempDir("omp-mpn-agent-");
	const cwd = options.cwd ?? makeTempDir("omp-mpn-proj-");
	// Embeddings off by default: a local embedder would want a worker, and every
	// assertion here is about storage, routing and rendering, not vectors.
	const settings = fakeSettings({ "mempalaceNative.embeddings": false, ...options.settings });
	const session = fakeSession(cwd, settings);
	const agentSession = session as unknown as AgentSession;
	const startOptions: MemoryBackendStartOptions = {
		session: agentSession,
		settings,
		modelRegistry: NO_MODEL_REGISTRY,
		agentDir,
		taskDepth: options.taskDepth ?? 0,
	};
	await mempalaceNativeBackend.start(startOptions);

	const attached = getAttached(agentSession);
	if (attached) openStates.push(attached);
	return {
		agentDir,
		cwd,
		wing: wingNameFor(cwd),
		dbPath: join(agentDir, "mempalace-native", "palace.db"),
		session,
		agentSession,
		context: { agentDir, cwd, session: agentSession },
		attached: () => getAttached(agentSession),
	};
}

/**
 * `state.ts` hands back the `MempalaceNativeSession` interface; the tests want
 * the concrete class (config, scheduler handle, dispose), so narrow by identity
 * exactly as the backend itself does.
 */
function getAttached(session: AgentSession): MempalaceNativeSessionState | undefined {
	const state = getMempalaceNativeSessionState(session);
	return state instanceof MempalaceNativeSessionState ? state : undefined;
}

// ── Collaborator stubs ──────────────────────────────────────────────────────

function stubSearcher(): Searcher {
	return {
		search: async query => ({ query: query.text, mode: "lexical", effectiveMode: "lexical", hits: [] }),
		wakeUp: async () => ({ headline: "", inventory: [], highlights: [], diary: [], approxTokens: 0 }),
		indexPending: async () => 0,
	};
}

interface StubMiner extends Miner {
	mined: MineOptions[];
	planned: MineOptions[];
}

function stubMiner(): StubMiner {
	const stub: StubMiner = {
		mined: [],
		planned: [],
		plan: async options => {
			stub.planned.push(options);
			return {
				mode: "project",
				candidateFiles: 0,
				changedFiles: 0,
				unchangedFiles: 0,
				changedBytes: 0,
				estimatedMillis: 0,
				truncated: false,
			};
		},
		mine: async options => {
			stub.mined.push(options);
			return {
				mode: "project",
				filesScanned: 0,
				filesSkipped: 0,
				filesUnchanged: 0,
				drawersCreated: 0,
				drawersUpdated: 0,
				completed: true,
				elapsedMillis: 0,
				warnings: [],
			};
		},
		sync: async () => ({ checked: 0, pruned: 0 }),
		dispose: () => {},
	};
	return stub;
}

interface StubScheduler extends MineScheduler {
	triggers: MineTrigger[];
	userTurns: number;
	turnEnds: number;
	cancels: number;
}

function stubScheduler(): StubScheduler {
	const stub: StubScheduler = {
		triggers: [],
		userTurns: 0,
		turnEnds: 0,
		cancels: 0,
		noteUserTurn: () => {
			stub.userTurns++;
		},
		noteTurnEnd: () => {
			stub.turnEnds++;
		},
		shouldMine: async trigger => ({ run: true, reason: "stub always agrees", trigger }),
		requestMine: async trigger => {
			stub.triggers.push(trigger);
			return null;
		},
		cancel: () => {
			stub.cancels++;
		},
		state: () => ({
			running: false,
			turnsSinceMine: stub.userTurns,
			idleStreak: 0,
			resumePending: false,
		}),
		dispose: () => {},
	};
	return stub;
}

interface StubbedHarness {
	state: MempalaceNativeSessionState;
	session: FakeSession;
	agentSession: AgentSession;
	miner: StubMiner;
	scheduler: StubScheduler | undefined;
	agentDir: string;
	cwd: string;
	context: { agentDir: string; cwd: string; session: AgentSession };
}

/** A real vault wired to stub collaborators, attached to a fake session. */
function makeStubbedState(options: { withScheduler?: boolean } = {}): StubbedHarness {
	const agentDir = makeTempDir("omp-mpn-agent-");
	const cwd = makeTempDir("omp-mpn-proj-");
	const config = loadMempalaceNativeConfig(fakeSettings({ "mempalaceNative.embeddings": false }), agentDir, cwd);
	const session = fakeSession(cwd, fakeSettings());
	const agentSession = session as unknown as AgentSession;
	const miner = stubMiner();
	const scheduler = options.withScheduler === false ? undefined : stubScheduler();
	const state = new MempalaceNativeSessionState({
		config,
		vault: openVault({ path: config.dbPath }),
		searcher: stubSearcher(),
		miner,
		scheduler,
		embeddings: false,
		session: agentSession,
	});
	openStates.push(state);
	setMempalaceNativeSessionState(agentSession, state);
	return {
		state,
		session,
		agentSession,
		miner,
		scheduler,
		agentDir,
		cwd,
		context: { agentDir, cwd, session: agentSession },
	};
}

// ── Config ──────────────────────────────────────────────────────────────────

describe("loadMempalaceNativeConfig", () => {
	test("falls back to the documented defaults when nothing is configured", () => {
		const agentDir = makeTempDir("omp-mpn-agent-");
		const cwd = makeTempDir("omp-mpn-proj-");

		const config = loadMempalaceNativeConfig(fakeSettings(), agentDir, cwd);

		expect(config.dbPath).toBe(join(agentDir, "mempalace-native", "palace.db"));
		expect(config.wing).toBe(wingNameFor(cwd));
		expect(config.cwd).toBe(cwd);
		expect(config.agentDir).toBe(agentDir);
		expect(config.embeddings).toBe(true);
		expect(config.embedModel).toBe(DEFAULT_MEMPALACE_EMBED_MODEL);
		expect(config.searchLimit).toBe(10);
		expect(config.wakeUpTokenBudget).toBe(900);
		expect(config.autoIngest).toBe(false);
		expect(config.ingestIntervalMessages).toBe(15);
		expect(config.mineBudgetMillis).toBe(4000);
		expect(config.mineIdleDelayMillis).toBe(2000);
		expect(config.mineMinIntervalMillis).toBe(60_000);
		expect(config.mineMaxAutoEstimatedMillis).toBe(120_000);
	});

	test("ignores a non-numeric interval instead of coercing it", () => {
		const config = loadMempalaceNativeConfig(
			fakeSettings({ "mempalaceNative.ingestIntervalMessages": "every other turn" }),
			"/agent",
			"/proj",
		);

		expect(config.ingestIntervalMessages).toBe(15);
	});

	test("ignores a negative budget instead of clamping it to the floor", () => {
		const config = loadMempalaceNativeConfig(
			fakeSettings({
				"mempalaceNative.mineBudgetMillis": -1,
				"mempalaceNative.mineIdleDelayMillis": -5000,
			}),
			"/agent",
			"/proj",
		);

		expect(config.mineBudgetMillis).toBe(4000);
		// The idle delay's floor is a legal `0`, so clamping a negative would
		// have disguised the bad value as "mine the instant a turn ends".
		expect(config.mineIdleDelayMillis).toBe(2000);
	});

	test("clamps out-of-range numbers into their documented window", () => {
		const config = loadMempalaceNativeConfig(
			fakeSettings({
				"mempalaceNative.searchLimit": 5000,
				"mempalaceNative.wakeUpTokenBudget": 5,
				"mempalaceNative.mineMinIntervalMillis": 99_999_999,
				"mempalaceNative.mineMaxAutoEstimatedMillis": 10,
			}),
			"/agent",
			"/proj",
		);

		expect(config.searchLimit).toBe(50);
		expect(config.wakeUpTokenBudget).toBe(100);
		expect(config.mineMinIntervalMillis).toBe(3_600_000);
		expect(config.mineMaxAutoEstimatedMillis).toBe(1000);
	});

	test("ignores non-boolean flags and resolves a relative dbPath against cwd", () => {
		const config = loadMempalaceNativeConfig(
			fakeSettings({
				"mempalaceNative.embeddings": "yes",
				"mempalaceNative.autoIngest": 1,
				"mempalaceNative.dbPath": "  .palace/db.sqlite  ",
			}),
			"/agent",
			"/proj",
		);

		expect(config.embeddings).toBe(true);
		expect(config.autoIngest).toBe(false);
		expect(config.dbPath).toBe(resolve("/proj", ".palace/db.sqlite"));
	});

	test("survives a settings store that throws on every unregistered key", () => {
		const hostile = {
			get(key: string): never {
				throw new Error(`unknown setting: ${key}`);
			},
		} as unknown as Settings;

		const config = loadMempalaceNativeConfig(hostile, "/agent", "/proj");

		expect(config.searchLimit).toBe(10);
		expect(config.embeddings).toBe(true);
		expect(config.autoIngest).toBe(false);
		expect(config.dbPath).toBe(join("/agent", "mempalace-native", "palace.db"));
	});
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe("mempalaceNativeBackend lifecycle", () => {
	test("status reports an inactive backend before start", async () => {
		const cwd = makeTempDir("omp-mpn-proj-");
		const session = fakeSession(cwd, fakeSettings());

		const status = await mempalaceNativeBackend.status!({
			agentDir: "/agent",
			cwd,
			session: session as unknown as AgentSession,
		});

		expect(status.backend).toBe("mempalace-native");
		expect(status.active).toBe(false);
		expect(status.writable).toBe(false);
		expect(status.searchable).toBe(false);
		expect(status.message).toContain("not initialised");
	});

	test("start opens the vault, attaches a scheduler, and summarises both in status", async () => {
		const harness = await startBackend();

		const state = harness.attached();
		expect(state).toBeDefined();
		expect(state?.scheduler).toBeDefined();
		// Exactly one subscription: the Smart Mining turn observer.
		expect(harness.session.listenerCount()).toBe(1);

		await mempalaceNativeBackend.save!(harness.context, { content: "the grid overlay shares the content box" });

		const status = await mempalaceNativeBackend.status!(harness.context);
		expect(status.backend).toBe("mempalace-native");
		expect(status.active).toBe(true);
		expect(status.writable).toBe(true);
		expect(status.searchable).toBe(true);
		expect(status.scope).toBe(harness.wing);
		expect(status.database).toBe(harness.dbPath);
		expect(status.workingCount).toBe(1);
		expect(status.episodicCount).toBe(0);
		expect(status.message).toContain("Lexical-only");
		expect(status.message).toContain("auto-ingest off");
		expect(status.message).toContain("since last mine");
		expect(status.message).toContain("resume pending");
	});

	test("start survives a db path it cannot open", async () => {
		const agentDir = makeTempDir("omp-mpn-agent-");
		const cwd = makeTempDir("omp-mpn-proj-");
		// A regular file where the palace's parent directory would have to be:
		// both the mkdir and the sqlite open fail with ENOTDIR.
		const blocker = join(agentDir, "not-a-directory");
		writeFileSync(blocker, "");

		const harness = await startBackend({
			agentDir,
			cwd,
			settings: { "mempalaceNative.dbPath": join(blocker, "palace.db") },
		});

		expect(harness.attached()).toBeUndefined();
		expect(harness.session.listenerCount()).toBe(0);

		const status = await mempalaceNativeBackend.status!(harness.context);
		expect(status.active).toBe(false);
		expect(status.message).toContain("not initialised");

		// Every other entry point degrades rather than throwing.
		await expect(mempalaceNativeBackend.search!(harness.context, "anything")).resolves.toMatchObject({
			count: 0,
			items: [],
		});
		await expect(
			mempalaceNativeBackend.save!(harness.context, { content: "nowhere to put this" }),
		).resolves.toMatchObject({ stored: 0 });
		await expect(mempalaceNativeBackend.clear(agentDir, cwd, harness.agentSession)).resolves.toBeUndefined();
		await expect(mempalaceNativeBackend.enqueue(agentDir, cwd, harness.agentSession)).resolves.toBeUndefined();
		expect(
			await mempalaceNativeBackend.buildDeveloperInstructions(
				agentDir,
				harness.session.settings,
				harness.agentSession,
			),
		).toBeUndefined();
		expect(await mempalaceNativeBackend.stats!(agentDir, cwd, harness.agentSession)).toBeUndefined();
		expect(await mempalaceNativeBackend.diagnose!(agentDir, cwd, harness.agentSession)).toBeUndefined();
	});

	test("a subagent shares the palace but never gets a scheduler", async () => {
		const agentDir = makeTempDir("omp-mpn-agent-");
		const cwd = makeTempDir("omp-mpn-proj-");
		const parent = await startBackend({ agentDir, cwd, taskDepth: 0 });
		await mempalaceNativeBackend.save!(parent.context, { content: "the parent wrote this before the fan-out" });

		const child = await startBackend({ agentDir, cwd, taskDepth: 1 });
		const state = child.attached();

		expect(state).toBeDefined();
		expect(state?.scheduler).toBeUndefined();
		expect(state?.schedulerState()).toBeUndefined();
		// Nothing to observe without a scheduler, so no listener is registered.
		expect(child.session.listenerCount()).toBe(0);

		// The same palace file, and it is fully usable — only mining is withheld.
		expect(state?.config.dbPath).toBe(parent.dbPath);
		const found = await mempalaceNativeBackend.search!(child.context, "fan-out");
		expect(found.count).toBeGreaterThan(0);

		const status = await mempalaceNativeBackend.status!(child.context);
		expect(status.active).toBe(true);
		expect(status.writable).toBe(true);
		expect(status.message).toContain("no scheduler");
	});
});

// ── Smart Mining turn observation ───────────────────────────────────────────

describe("mempalaceNativeBackend turn observation", () => {
	test("agent_start and a terminal agent_end drive the scheduler", () => {
		const harness = makeStubbedState();
		const scheduler = harness.scheduler!;

		harness.state.attachSessionListeners();
		expect(harness.session.listenerCount()).toBe(1);

		harness.session.emit({ type: "agent_start" });
		harness.session.emit({ type: "agent_end", isTerminal: true });
		expect(scheduler.userTurns).toBe(1);
		expect(scheduler.turnEnds).toBe(1);

		// `isTerminal: false` means an async delivery will resume the session, so
		// the turn is not over and the idle window must not arm.
		harness.session.emit({ type: "agent_end", isTerminal: false });
		expect(scheduler.turnEnds).toBe(1);

		// An `agent_end` with no flag at all is a normal settle.
		harness.session.emit({ type: "agent_end" });
		expect(scheduler.turnEnds).toBe(2);

		harness.state.dispose();
		expect(harness.session.listenerCount()).toBe(0);
	});

	test("a state without a scheduler never subscribes", () => {
		const harness = makeStubbedState({ withScheduler: false });

		harness.state.attachSessionListeners();

		expect(harness.session.listenerCount()).toBe(0);
		expect(harness.state.schedulerState()).toBeUndefined();
	});

	test("enqueue asks the scheduler for a manual run, bypassing the cadence gates", async () => {
		const harness = makeStubbedState();

		await mempalaceNativeBackend.enqueue(harness.agentDir, harness.cwd, harness.agentSession);

		expect(harness.scheduler?.triggers).toEqual(["manual"]);
		// The scheduler owns the run, so the miner is never called behind its back.
		expect(harness.miner.mined).toHaveLength(0);
	});

	test("enqueue without a scheduler mines directly, with no budget ceiling", async () => {
		const harness = makeStubbedState({ withScheduler: false });

		await mempalaceNativeBackend.enqueue(harness.agentDir, harness.cwd, harness.agentSession);

		expect(harness.miner.mined).toHaveLength(1);
		expect(harness.miner.mined[0]?.dir).toBe(harness.cwd);
		expect(harness.miner.mined[0]?.wing).toBe(wingNameFor(harness.cwd));
		expect(harness.miner.mined[0]?.budgetMillis).toBeUndefined();
	});

	test("clear cancels an in-flight mine before wiping", async () => {
		const harness = makeStubbedState();
		await mempalaceNativeBackend.save!(harness.context, { content: "a fact worth forgetting" });
		expect(harness.state.stats().drawers).toBe(1);

		await mempalaceNativeBackend.clear(harness.agentDir, harness.cwd, harness.agentSession);

		expect(harness.scheduler?.cancels).toBe(1);
		expect(harness.state.stats().drawers).toBe(0);
	});
});

// ── Save and search ─────────────────────────────────────────────────────────

describe("mempalaceNativeBackend save and search", () => {
	test("a saved drawer comes back out of search", async () => {
		const harness = await startBackend();

		const saved = await mempalaceNativeBackend.save!(harness.context, {
			content: "The zoraxy docroot on CT403 is already occupied by a live preview.",
			context: "infrastructure",
		});
		expect(saved.backend).toBe("mempalace-native");
		expect(saved.stored).toBe(1);
		const savedId = saved.ids?.[0];
		expect(savedId).toBeTruthy();

		const found = await mempalaceNativeBackend.search!(harness.context, "zoraxy docroot");

		expect(found.backend).toBe("mempalace-native");
		expect(found.count).toBeGreaterThan(0);
		expect(found.items[0]?.id).toBe(savedId!);
		expect(found.items[0]?.content).toContain("zoraxy");
		expect(found.items[0]?.source).toBe(`${harness.wing}/infrastructure`);
		expect(found.items[0]?.timestamp).toBeTruthy();
		expect(typeof found.items[0]?.score).toBe("number");
	});

	test("a duplicate save is reported instead of silently double-filed", async () => {
		const harness = await startBackend();
		const content = "Bun's sqlite `changes` counter includes trigger writes.";

		const first = await mempalaceNativeBackend.save!(harness.context, { content });
		const second = await mempalaceNativeBackend.save!(harness.context, { content });

		expect(first.stored).toBe(1);
		expect(second.stored).toBe(0);
		expect(second.ids).toEqual(first.ids!);
		expect(second.message).toBeTruthy();
		expect(second.message).toContain("already filed");
		expect(harness.attached()?.stats().drawers).toBe(1);
	});

	test("empty content is refused before it reaches the vault", async () => {
		const harness = await startBackend();

		const result = await mempalaceNativeBackend.save!(harness.context, { content: "   " });

		expect(result.stored).toBe(0);
		expect(result.message).toBe("Memory content is empty.");
		expect(harness.attached()?.stats().drawers).toBe(0);
	});

	test("a diary save lands in the diary and never in the drawers", async () => {
		const harness = await startBackend();

		const viaContext = await mempalaceNativeBackend.save!(harness.context, {
			content: "SESSION:2026-08-12 wired the native palace backend",
			context: "diary",
		});
		const viaSource = await mempalaceNativeBackend.save!(harness.context, {
			content: "SESSION:2026-08-13 taught the scheduler to wait for idle",
			source: "diary",
		});

		expect(viaContext.stored).toBe(1);
		expect(viaSource.stored).toBe(1);

		const state = harness.attached();
		expect(state?.listDrawers()).toHaveLength(0);
		const diary = state?.readDiary() ?? [];
		expect(diary).toHaveLength(2);
		expect(diary.map(entry => entry.wing)).toEqual([harness.wing, harness.wing]);
		expect(diary.map(entry => entry.content).join("\n")).toContain("wired the native palace backend");

		const status = await mempalaceNativeBackend.status!(harness.context);
		expect(status.workingCount).toBe(0);
		expect(status.episodicCount).toBe(2);
	});

	test("search honours an explicit limit and an aborted signal", async () => {
		const harness = await startBackend();
		for (const n of [1, 2, 3]) {
			await mempalaceNativeBackend.save!(harness.context, { content: `palace fixture number ${n} about beacons` });
		}

		const limited = await mempalaceNativeBackend.search!(harness.context, "beacons", { limit: 2 });
		expect(limited.count).toBeGreaterThan(0);
		expect(limited.count).toBeLessThanOrEqual(2);

		const controller = new AbortController();
		controller.abort();
		const aborted = await mempalaceNativeBackend.search!(harness.context, "beacons", { signal: controller.signal });
		expect(aborted.count).toBe(0);
		expect(aborted.items).toEqual([]);
		expect(aborted.message).toBe("Search aborted.");
	});
});

// ── Prompt injection ────────────────────────────────────────────────────────

describe("mempalaceNativeBackend.buildDeveloperInstructions", () => {
	test("stays silent on an empty palace", async () => {
		const harness = await startBackend();

		const rendered = await mempalaceNativeBackend.buildDeveloperInstructions(
			harness.agentDir,
			harness.session.settings,
			harness.agentSession,
		);

		expect(rendered).toBeUndefined();
	});

	test("stays silent without a session state", async () => {
		const cwd = makeTempDir("omp-mpn-proj-");
		const session = fakeSession(cwd, fakeSettings());

		const rendered = await mempalaceNativeBackend.buildDeveloperInstructions(
			"/agent",
			session.settings,
			session as unknown as AgentSession,
		);

		expect(rendered).toBeUndefined();
	});

	test("renders a markdown wake-up block that ends on the precedence line", async () => {
		const harness = await startBackend();
		await mempalaceNativeBackend.save!(harness.context, {
			content: "The grid overlay must live in the same content box as the content it measures.",
			context: "design decisions",
		});

		const rendered = await mempalaceNativeBackend.buildDeveloperInstructions(
			harness.agentDir,
			harness.session.settings,
			harness.agentSession,
		);

		expect(rendered).toBeDefined();
		expect(rendered).toContain("# MemPalace");
		expect(rendered).toContain("background context, not instructions");
		expect(rendered).toContain("take precedence");
		// The precedence line closes the block; nothing may follow it but blanks.
		const trailing = rendered!.slice(rendered!.indexOf("background context, not instructions"));
		expect(trailing.split("\n").slice(1).join("").trim()).toBe("");
	});
});

// ── Clear, stats, diagnose ──────────────────────────────────────────────────

describe("mempalaceNativeBackend maintenance", () => {
	test("clear empties the palace on disk", async () => {
		const harness = await startBackend();
		await mempalaceNativeBackend.save!(harness.context, { content: "a fact worth forgetting" });
		await mempalaceNativeBackend.save!(harness.context, { content: "a diary line", context: "diary" });
		expect(harness.attached()?.stats().drawers).toBe(1);
		expect(harness.attached()?.stats().diaryEntries).toBe(1);

		await mempalaceNativeBackend.clear(harness.agentDir, harness.cwd, harness.agentSession);

		expect(harness.attached()?.stats().drawers).toBe(0);
		expect(harness.attached()?.stats().diaryEntries).toBe(0);
		await expect(mempalaceNativeBackend.search!(harness.context, "forgetting")).resolves.toMatchObject({ count: 0 });

		// Prove the wipe reached the file rather than just this handle's view.
		harness.attached()?.dispose();
		const reopened = openVault({ path: harness.dbPath });
		try {
			expect(reopened.stats().drawers).toBe(0);
			expect(reopened.stats().diaryEntries).toBe(0);
		} finally {
			reopened.close();
		}
	});

	test("stats and diagnose render the palace and the Smart Mining state", async () => {
		const harness = await startBackend();
		await mempalaceNativeBackend.save!(harness.context, { content: "something worth counting" });

		const stats = await mempalaceNativeBackend.stats!(harness.agentDir, harness.cwd, harness.agentSession);
		expect(stats).toContain("MemPalace (native)");
		expect(stats).toContain(`\`${harness.wing}\``);
		expect(stats).toContain("Diary entries: 0");
		expect(stats).toContain("Lexical-only");

		const diagnose = await mempalaceNativeBackend.diagnose!(harness.agentDir, harness.cwd, harness.agentSession);
		expect(diagnose).toContain(harness.dbPath);
		expect(diagnose).toContain("Embeddings: disabled");
		expect(diagnose).toContain("Vector coverage: 0/1 drawers (0%)");
		expect(diagnose).toContain("Mining ledger: 0 files");
		expect(diagnose).toContain("Smart Mining");
		expect(diagnose).toContain("Auto-ingest: off");
		expect(diagnose).toContain("Turns since last mine: 0");
		expect(diagnose).toContain("Resume pending: false");
	});
});
