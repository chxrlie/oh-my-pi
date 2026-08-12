import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMineWorkerHandle, type MempalaceMineWorkerHandle } from "../src/mempalace-native/mine-client";
import type { MineWorkerInbound, MineWorkerOutbound } from "../src/mempalace-native/mine-protocol";
import { createMiner } from "../src/mempalace-native/miner";
import type {
	DrawerInput,
	DrawerWriteResult,
	MinedFilePayload,
	MinedFileRecord,
	MinePlan,
	MineRunSummary,
	MineWorkerHandle,
	MineWorkerPlanRequest,
	MineWorkerRunRequest,
	Vault,
} from "../src/mempalace-native/types";

/**
 * Miner + mine-client contract. No subprocess is ever spawned: the worker is
 * injected through `MinerOptions.spawnWorker`, and the client tests drive a
 * hand-rolled child handle in-process so the `file` → `ack` handshake can be
 * observed message by message.
 */

const WING = "acme_app";
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 2000;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mp-miner-"));
	tempDirs.push(dir);
	return dir;
}

function summaryOf(overrides: Partial<MineRunSummary> = {}): MineRunSummary {
	return { filesScanned: 0, filesSkipped: 0, filesUnchanged: 0, completed: true, warnings: [], ...overrides };
}

function payload(filePath: string, chunkCount: number, overrides: Partial<MinedFilePayload> = {}): MinedFilePayload {
	return {
		path: filePath,
		size: 100,
		mtimeMs: 1_700_000_000_000,
		contentHash: `sha-${path.basename(filePath)}`,
		room: "root",
		chunks: Array.from({ length: chunkCount }, (_unused, index) => ({
			title: `chunk ${index}`,
			body: `body ${index}`,
		})),
		...overrides,
	};
}

/**
 * The six `Vault` members the miner reaches for. `Vault` is a thirty-method
 * storage surface owned by another module and backed by a sqlite file, so the
 * fake models only the reachable slice and is cast through `unknown` — the same
 * shape the existing mempalace state test uses for `AgentSession`.
 */
interface RecordedVault {
	vault: Vault;
	/** One entry per `addDrawers` call, in call order. */
	batches: DrawerInput[][];
	recorded: MinedFileRecord[];
	deleted: string[];
	forgotten: string[];
	/** The wing argument of every `getMinedFiles` call. */
	ledgerWings: (string | undefined)[];
}

function createFakeVault(
	options: {
		minedFiles?: Record<string, { size: number; mtimeMs: number }>;
		sourcePaths?: string[];
		deleteCount?: number;
		writeResults?: (inputs: readonly DrawerInput[]) => DrawerWriteResult[];
	} = {},
): RecordedVault {
	const batches: DrawerInput[][] = [];
	const recorded: MinedFileRecord[] = [];
	const deleted: string[] = [];
	const forgotten: string[] = [];
	const ledgerWings: (string | undefined)[] = [];

	const minedFiles = new Map<string, MinedFileRecord>();
	for (const [minedPath, stat] of Object.entries(options.minedFiles ?? {})) {
		minedFiles.set(minedPath, {
			path: minedPath,
			wing: WING,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			contentHash: "sha-ledger",
			minedAt: "2026-08-01T00:00:00.000Z",
			drawerCount: 1,
		});
	}

	const members = {
		getMinedFiles(wing?: string): Map<string, MinedFileRecord> {
			ledgerWings.push(wing);
			return minedFiles;
		},
		addDrawers(inputs: readonly DrawerInput[]): DrawerWriteResult[] {
			batches.push([...inputs]);
			if (options.writeResults) return options.writeResults(inputs);
			return inputs.map((_unused, index) => ({
				id: `drawer-${batches.length}-${index}`,
				created: true,
				updated: false,
			}));
		},
		recordMinedFile(record: MinedFileRecord): void {
			recorded.push(record);
		},
		forgetMinedFile(minedPath: string): void {
			forgotten.push(minedPath);
		},
		knownSourcePaths(): string[] {
			return options.sourcePaths ?? [];
		},
		deleteBySource(sourcePath: string): number {
			deleted.push(sourcePath);
			return options.deleteCount ?? 0;
		},
	};

	return { vault: members as unknown as Vault, batches, recorded, deleted, forgotten, ledgerWings };
}

interface FakeWorker extends MineWorkerHandle {
	planRequests: MineWorkerPlanRequest[];
	runRequests: MineWorkerRunRequest[];
	disposeCount: number;
}

function createFakeWorker(
	script: {
		plan?: MinePlan | null;
		run?: (
			request: MineWorkerRunRequest,
			onFile: (file: MinedFilePayload) => Promise<void> | void,
		) => Promise<MineRunSummary>;
	} = {},
): FakeWorker {
	const worker: FakeWorker = {
		planRequests: [],
		runRequests: [],
		disposeCount: 0,
		async plan(request) {
			worker.planRequests.push(request);
			return script.plan ?? null;
		},
		async run(request, onFile) {
			worker.runRequests.push(request);
			if (!script.run) return summaryOf();
			return await script.run(request, onFile);
		},
		dispose() {
			worker.disposeCount += 1;
		},
	};
	return worker;
}

/** Stream `files` through the parent, then report a tidy completed summary. */
function streamAll(files: MinedFilePayload[]) {
	return async (
		_request: MineWorkerRunRequest,
		onFile: (file: MinedFilePayload) => Promise<void> | void,
	): Promise<MineRunSummary> => {
		for (const file of files) await onFile(file);
		return summaryOf({ filesScanned: files.length });
	};
}

describe("createMiner ledger and mode", () => {
	test("flattens the ledger to size:mtimeMs for both plan and run", async () => {
		const root = makeTempDir();
		const alpha = path.join(root, "alpha.ts");
		const beta = path.join(root, "beta.ts");
		const vault = createFakeVault({
			minedFiles: { [alpha]: { size: 120, mtimeMs: 1700 }, [beta]: { size: 8, mtimeMs: 42 } },
		});
		const worker = createFakeWorker();
		const miner = createMiner(vault.vault, { cwd: root, spawnWorker: () => worker });

		await miner.plan({ dir: root, wing: WING });
		await miner.mine({ dir: root, wing: WING });

		const expected = { [alpha]: "120:1700", [beta]: "8:42" };
		expect(worker.planRequests[0].ledger).toEqual(expected);
		expect(worker.runRequests[0].ledger).toEqual(expected);
		expect(vault.ledgerWings).toEqual([WING, WING]);
		expect(worker.planRequests[0]).toEqual({
			dir: root,
			mode: "project",
			maxFileBytes: DEFAULT_MAX_FILE_BYTES,
			maxFiles: DEFAULT_MAX_FILES,
			ledger: expected,
			force: false,
		});
		expect(worker.runRequests[0].budgetMillis).toBe(0);
		miner.dispose();
	});

	test("resolves a relative target against the miner cwd", async () => {
		const root = makeTempDir();
		const nested = path.join(root, "packages", "core");
		fs.mkdirSync(nested, { recursive: true });
		const vault = createFakeVault();
		const worker = createFakeWorker();
		const miner = createMiner(vault.vault, { cwd: root, spawnWorker: () => worker });

		await miner.plan({ dir: path.join("packages", "core"), wing: WING });

		expect(worker.planRequests[0].dir).toBe(nested);
		miner.dispose();
	});

	test("auto-detects convos mode at and under the stubbed sessions root", async () => {
		const root = makeTempDir();
		const sessions = path.join(root, "sessions");
		const nested = path.join(sessions, "acme-app");
		fs.mkdirSync(nested, { recursive: true });
		const transcript = payload(path.join(nested, "2026-08-12.jsonl"), 1);
		const vault = createFakeVault();
		const worker = createFakeWorker({ run: streamAll([transcript]) });
		const miner = createMiner(vault.vault, {
			cwd: root,
			sessionsDir: () => sessions,
			spawnWorker: () => worker,
		});

		const atRoot = await miner.mine({ dir: sessions, wing: WING });
		const underRoot = await miner.mine({ dir: nested, wing: WING });

		expect(atRoot.mode).toBe("convos");
		expect(underRoot.mode).toBe("convos");
		expect(worker.runRequests.map(request => request.mode)).toEqual(["convos", "convos"]);
		// Convo drawers are labelled apart from source-tree drawers so search can filter them.
		expect(vault.batches[0][0]).toMatchObject({ source: "convo", origin: "convo" });
		miner.dispose();
	});

	test("keeps a sibling of the sessions root in project mode", async () => {
		const root = makeTempDir();
		const sessions = path.join(root, "sessions");
		// A plain `startsWith` on the sessions root would swallow this directory
		// and chunk whatever lives in it as if it were a harness transcript.
		const sibling = path.join(root, "sessions-archive");
		fs.mkdirSync(sessions, { recursive: true });
		fs.mkdirSync(sibling, { recursive: true });
		const vault = createFakeVault();
		const worker = createFakeWorker({ run: streamAll([payload(path.join(sibling, "notes.md"), 1)]) });
		const miner = createMiner(vault.vault, {
			cwd: root,
			sessionsDir: () => sessions,
			spawnWorker: () => worker,
		});

		const result = await miner.mine({ dir: sibling, wing: WING });

		expect(result.mode).toBe("project");
		expect(worker.runRequests[0].mode).toBe("project");
		expect(vault.batches[0][0]).toMatchObject({ source: "mine", origin: "mined" });
		miner.dispose();
	});

	test("lets an explicit mode override auto-detection in both directions", async () => {
		const root = makeTempDir();
		const sessions = path.join(root, "sessions");
		const plain = path.join(root, "src");
		fs.mkdirSync(sessions, { recursive: true });
		fs.mkdirSync(plain, { recursive: true });
		const vault = createFakeVault();
		const worker = createFakeWorker();
		const miner = createMiner(vault.vault, {
			cwd: root,
			sessionsDir: () => sessions,
			spawnWorker: () => worker,
		});

		const forced = await miner.plan({ dir: sessions, wing: WING, mode: "project" });
		const opted = await miner.plan({ dir: plain, wing: WING, mode: "convos" });

		expect(worker.planRequests.map(request => request.mode)).toEqual(["project", "convos"]);
		expect(forced.mode).toBe("project");
		expect(opted.mode).toBe("convos");
		miner.dispose();
	});

	test("stays in project mode when no sessions root is configured", async () => {
		const root = makeTempDir();
		const vault = createFakeVault();
		const worker = createFakeWorker();
		const miner = createMiner(vault.vault, { cwd: root, spawnWorker: () => worker });

		await miner.plan({ dir: root, wing: WING });

		expect(worker.planRequests[0].mode).toBe("project");
		miner.dispose();
	});
});

describe("createMiner persistence", () => {
	test("files one drawer batch and one ledger row per streamed file", async () => {
		const root = makeTempDir();
		const first = payload(path.join(root, "src", "index.ts"), 2, {
			room: "src",
			size: 321,
			mtimeMs: 555,
			contentHash: "sha-index",
		});
		const second = payload(path.join(root, "readme.md"), 1, {
			room: "root",
			size: 12,
			mtimeMs: 9,
			contentHash: "sha-readme",
		});
		const vault = createFakeVault();
		const worker = createFakeWorker({ run: streamAll([first, second]) });
		const miner = createMiner(vault.vault, { cwd: root, spawnWorker: () => worker });

		const result = await miner.mine({ dir: root, wing: WING });

		expect(vault.batches).toHaveLength(2);
		expect(vault.batches[0]).toEqual([
			{
				wing: WING,
				room: "src",
				title: "index.ts — chunk 0",
				content: "body 0",
				source: "mine",
				sourcePath: first.path,
				origin: "mined",
				addedBy: "omp",
			},
			{
				wing: WING,
				room: "src",
				title: "index.ts — chunk 1",
				content: "body 1",
				source: "mine",
				sourcePath: first.path,
				origin: "mined",
				addedBy: "omp",
			},
		]);
		expect(vault.batches[1]).toHaveLength(1);
		expect(vault.recorded).toEqual([
			{
				path: first.path,
				wing: WING,
				size: 321,
				mtimeMs: 555,
				contentHash: "sha-index",
				minedAt: expect.any(String),
				drawerCount: 2,
			},
			{
				path: second.path,
				wing: WING,
				size: 12,
				mtimeMs: 9,
				contentHash: "sha-readme",
				minedAt: expect.any(String),
				drawerCount: 1,
			},
		]);
		expect(result.completed).toBe(true);
		expect(result.filesScanned).toBe(2);
		miner.dispose();
	});

	test("aggregates created and updated drawers across files", async () => {
		const root = makeTempDir();
		const first = payload(path.join(root, "a.ts"), 3);
		const second = payload(path.join(root, "b.ts"), 2);
		const vault = createFakeVault({
			// Per batch: one fresh drawer, one refreshed in place, and (for the
			// first file) one exact-duplicate that the vault deduped away.
			writeResults: inputs =>
				inputs.map((_unused, index) => ({
					id: `drawer-${index}`,
					created: index === 0,
					updated: index === 1,
				})),
		});
		const worker = createFakeWorker({ run: streamAll([first, second]) });
		const miner = createMiner(vault.vault, { cwd: root, spawnWorker: () => worker });

		const result = await miner.mine({ dir: root, wing: WING });

		expect(result.drawersCreated).toBe(2);
		expect(result.drawersUpdated).toBe(2);
		miner.dispose();
	});

	test("skips the ledger row when the vault rolls the whole batch back", async () => {
		const root = makeTempDir();
		const file = payload(path.join(root, "a.ts"), 2);
		const vault = createFakeVault({ writeResults: () => [] });
		const worker = createFakeWorker({ run: streamAll([file]) });
		const miner = createMiner(vault.vault, { cwd: root, spawnWorker: () => worker });

		const result = await miner.mine({ dir: root, wing: WING });

		expect(vault.batches).toHaveLength(1);
		// Nothing persisted, so the ledger must not claim the file was mined —
		// otherwise the retry would skip it as unchanged.
		expect(vault.recorded).toEqual([]);
		expect(result.drawersCreated).toBe(0);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain(file.path);
		miner.dispose();
	});
});

describe("createMiner degradation", () => {
	test("returns a zero plan when the worker is unavailable", async () => {
		const root = makeTempDir();
		const vault = createFakeVault();
		const worker = createFakeWorker({ plan: null });
		const miner = createMiner(vault.vault, { cwd: root, spawnWorker: () => worker });

		const plan = await miner.plan({ dir: root, wing: WING });

		expect(plan).toEqual({
			mode: "project",
			candidateFiles: 0,
			changedFiles: 0,
			unchangedFiles: 0,
			changedBytes: 0,
			estimatedMillis: 0,
			truncated: false,
		});
		miner.dispose();
	});

	test("reports a partial result when the worker dies mid-run", async () => {
		const root = makeTempDir();
		const file = payload(path.join(root, "a.ts"), 2);
		const death = "mempalace mine subprocess exited with signal SIGKILL";
		const vault = createFakeVault();
		const worker = createFakeWorker({
			run: async (_request, onFile) => {
				await onFile(file);
				// What `createMineWorkerHandle` hands back after `onError`: the
				// files it did stream, and no claim of completion.
				return summaryOf({ filesScanned: 1, completed: false, warnings: [death] });
			},
		});
		const miner = createMiner(vault.vault, { cwd: root, spawnWorker: () => worker });

		const result = await miner.mine({ dir: root, wing: WING });

		expect(result.completed).toBe(false);
		expect(result.filesScanned).toBe(1);
		expect(result.drawersCreated).toBe(2);
		expect(result.warnings).toEqual([death]);
		expect(vault.recorded).toHaveLength(1);
		miner.dispose();
	});

	test("returns a zero result and a warning for a missing target directory", async () => {
		const root = makeTempDir();
		const missing = path.join(root, "does-not-exist");
		const vault = createFakeVault();
		let spawns = 0;
		const miner = createMiner(vault.vault, {
			cwd: root,
			spawnWorker: () => {
				spawns += 1;
				return createFakeWorker();
			},
		});

		const result = await miner.mine({ dir: missing, wing: WING });

		expect(result).toEqual({
			mode: "project",
			filesScanned: 0,
			filesSkipped: 0,
			filesUnchanged: 0,
			drawersCreated: 0,
			drawersUpdated: 0,
			completed: false,
			elapsedMillis: expect.any(Number),
			warnings: [expect.stringContaining(missing)],
		});
		expect(vault.batches).toEqual([]);
		// A vanished target must not even cost a subprocess.
		expect(spawns).toBe(0);
		miner.dispose();
	});

	test("stops at the next file boundary once the signal aborts", async () => {
		const root = makeTempDir();
		const first = payload(path.join(root, "a.ts"), 1);
		const second = payload(path.join(root, "b.ts"), 1);
		const controller = new AbortController();
		let refused = false;
		const vault = createFakeVault();
		const worker = createFakeWorker({
			run: async (_request, onFile) => {
				await onFile(first);
				controller.abort();
				try {
					await onFile(second);
				} catch {
					// The real client converts a refused file into a `cancel`.
					refused = true;
				}
				return summaryOf({ filesScanned: 1, filesSkipped: 1, completed: false });
			},
		});
		const miner = createMiner(vault.vault, { cwd: root, spawnWorker: () => worker });

		const result = await miner.mine({ dir: root, wing: WING, signal: controller.signal });

		expect(refused).toBe(true);
		expect(result.completed).toBe(false);
		expect(result.drawersCreated).toBe(1);
		expect(vault.batches).toHaveLength(1);

		// A second mine on the already-aborted signal never reaches the worker.
		const again = await miner.mine({ dir: root, wing: WING, signal: controller.signal });
		expect(again.warnings).toEqual(["mine aborted before it started"]);
		expect(worker.runRequests).toHaveLength(1);
		miner.dispose();
	});
});

describe("createMiner sync", () => {
	test("prunes and forgets a vanished source while leaving a live one alone", async () => {
		const root = makeTempDir();
		const live = path.join(root, "live.ts");
		const gone = path.join(root, "gone.ts");
		fs.writeFileSync(live, "export const live = 1;\n");
		const vault = createFakeVault({ sourcePaths: [live, gone], deleteCount: 3 });
		const miner = createMiner(vault.vault, { cwd: root, spawnWorker: () => createFakeWorker() });

		const result = await miner.sync({ wing: WING });

		expect(result).toEqual({ checked: 2, pruned: 3 });
		expect(vault.deleted).toEqual([gone]);
		// Forgetting the ledger row is what lets the file re-mine if it returns.
		expect(vault.forgotten).toEqual([gone]);
		miner.dispose();
	});
});

describe("createMiner worker lifecycle", () => {
	test("spawns the worker at most once and releases it exactly once", async () => {
		const root = makeTempDir();
		const vault = createFakeVault();
		const worker = createFakeWorker();
		let spawns = 0;
		const miner = createMiner(vault.vault, {
			cwd: root,
			spawnWorker: () => {
				spawns += 1;
				return worker;
			},
		});

		await miner.mine({ dir: root, wing: WING });
		await miner.plan({ dir: root, wing: WING });
		expect(spawns).toBe(1);

		miner.dispose();
		miner.dispose();
		expect(worker.disposeCount).toBe(1);

		// A late call degrades instead of resurrecting the subprocess.
		const after = await miner.mine({ dir: root, wing: WING });
		expect(after.completed).toBe(false);
		expect(after.warnings).toEqual(["mine worker unavailable"]);
		expect(spawns).toBe(1);
		expect(worker.runRequests).toHaveLength(1);
	});
});

interface FakeChild {
	handle: MempalaceMineWorkerHandle;
	sent: MineWorkerInbound[];
	emit(message: MineWorkerOutbound): void;
	fail(error: Error): void;
	/**
	 * Resolves once the client has sent `count` messages. The signal the tests
	 * actually care about is the send itself, so they await that instead of
	 * guessing at a delay.
	 */
	waitForSent(count: number): Promise<void>;
	terminated: number;
}

/** An in-process stand-in for the spawned child: no IPC, no subprocess. */
function createFakeChild(): FakeChild {
	const listeners = new Set<(message: MineWorkerOutbound) => void>();
	const errorListeners = new Set<(error: Error) => void>();
	const waiters: { count: number; resolve: () => void }[] = [];
	const child: FakeChild = {
		sent: [],
		terminated: 0,
		emit(message) {
			for (const listener of [...listeners]) listener(message);
		},
		fail(error) {
			for (const listener of [...errorListeners]) listener(error);
		},
		waitForSent(count) {
			if (child.sent.length >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ count, resolve });
			return promise;
		},
		handle: {
			send(message) {
				child.sent.push(message);
				for (const waiter of waiters.splice(0)) {
					if (child.sent.length >= waiter.count) waiter.resolve();
					else waiters.push(waiter);
				}
			},
			onMessage(handler) {
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
			onError(handler) {
				errorListeners.add(handler);
				return () => errorListeners.delete(handler);
			},
			async terminate() {
				child.terminated += 1;
			},
		},
	};
	return child;
}

const PLAN_REQUEST: MineWorkerPlanRequest = {
	dir: "/tmp/acme",
	mode: "project",
	maxFileBytes: DEFAULT_MAX_FILE_BYTES,
	maxFiles: DEFAULT_MAX_FILES,
	ledger: {},
	force: false,
};
const RUN_REQUEST: MineWorkerRunRequest = { ...PLAN_REQUEST, budgetMillis: 0 };

describe("createMineWorkerHandle", () => {
	test("correlates a plan response and degrades a worker error to null", async () => {
		const child = createFakeChild();
		const handle = createMineWorkerHandle(() => child.handle);
		const plan: MinePlan = {
			mode: "project",
			candidateFiles: 12,
			changedFiles: 3,
			unchangedFiles: 9,
			changedBytes: 4096,
			estimatedMillis: 250,
			truncated: false,
		};

		const first = handle.plan(PLAN_REQUEST);
		expect(child.sent[0]).toEqual({ type: "plan", id: expect.any(String), request: PLAN_REQUEST });
		child.emit({ type: "plan", id: child.sent[0].id, plan });
		expect(await first).toEqual(plan);

		const second = handle.plan(PLAN_REQUEST);
		child.emit({ type: "error", id: child.sent[1].id, error: "walk failed" });
		expect(await second).toBeNull();

		handle.dispose();
	});

	test("acks only after the parent has persisted the file", async () => {
		const child = createFakeChild();
		const handle = createMineWorkerHandle(() => child.handle);
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const seen: string[] = [];

		const run = handle.run(RUN_REQUEST, async file => {
			seen.push(file.path);
			entered.resolve();
			await released.promise;
		});
		const id = child.sent[0].id;
		// Worker chatter must not be mistaken for a correlated reply.
		child.emit({ type: "log", level: "debug", msg: "walking" });
		child.emit({ type: "file", id, file: payload("/tmp/acme/a.ts", 1) });

		await entered.promise;
		expect(seen).toEqual(["/tmp/acme/a.ts"]);
		// The parent is inside `onFile`, so no ack can have gone out yet: the
		// vault write is what releases the child's walk.
		expect(child.sent.map(message => message.type)).toEqual(["run"]);

		const acked = child.waitForSent(2);
		released.resolve();
		await acked;
		expect(child.sent.map(message => message.type)).toEqual(["run", "ack"]);

		const summary = summaryOf({ filesScanned: 1 });
		child.emit({ type: "done", id, summary });
		expect(await run).toEqual(summary);
		handle.dispose();
	});

	test("turns a refused file into a cancel and denies the completion claim", async () => {
		const child = createFakeChild();
		const handle = createMineWorkerHandle(() => child.handle);

		const run = handle.run(RUN_REQUEST, () => {
			throw new Error("aborted");
		});
		const id = child.sent[0].id;
		const drained = child.waitForSent(3);
		child.emit({ type: "file", id, file: payload("/tmp/acme/a.ts", 1) });
		await drained;

		// The ack still goes out, so a child parked on the handshake drains to
		// `done` instead of wedging the run forever.
		expect(child.sent.map(message => message.type)).toEqual(["run", "cancel", "ack"]);

		child.emit({ type: "done", id, summary: summaryOf({ filesScanned: 1, completed: true }) });
		expect((await run).completed).toBe(false);
		handle.dispose();
	});

	test("degrades a run to a partial summary when the child dies", async () => {
		const child = createFakeChild();
		const handle = createMineWorkerHandle(() => child.handle);

		const run = handle.run(RUN_REQUEST, () => {});
		const id = child.sent[0].id;
		// The file is counted synchronously as it arrives, so the death that
		// follows cannot race the counter it is supposed to report.
		child.emit({ type: "file", id, file: payload("/tmp/acme/a.ts", 1) });
		child.fail(new Error("mempalace mine subprocess exited with signal SIGSEGV"));

		const summary = await run;
		expect(summary.completed).toBe(false);
		expect(summary.filesScanned).toBe(1);
		expect(summary.warnings).toEqual(["mempalace mine subprocess exited with signal SIGSEGV"]);
		handle.dispose();
	});

	test("hard-kills the child on dispose and never respawns", async () => {
		const child = createFakeChild();
		let spawns = 0;
		const handle = createMineWorkerHandle(() => {
			spawns += 1;
			return child.handle;
		});

		const run = handle.run(RUN_REQUEST, () => {});
		handle.dispose();

		expect((await run).completed).toBe(false);
		expect(child.terminated).toBe(1);
		expect(await handle.plan(PLAN_REQUEST)).toBeNull();
		expect(spawns).toBe(1);
	});
});
