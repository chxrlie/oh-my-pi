import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import type { CliRunResult } from "@oh-my-pi/pi-coding-agent/mempalace/cli";
import { MempalaceSessionState } from "@oh-my-pi/pi-coding-agent/mempalace/state";
import type { IngestTarget } from "@oh-my-pi/pi-coding-agent/mempalace/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const MARKER_FILE = ".mempalace-imported";

/** The `agent_end` payload; `MempalaceSessionState` only reads `type`. */
interface FakeEvent {
	type: string;
	messages: unknown[];
}

/**
 * The three `AgentSession` members the state touches. `AgentSession` is a
 * 7k-line class with no constructible test double, so fakes are cast through
 * `unknown` — structural typing cannot unify them and there is nothing here
 * worth validating at runtime.
 */
interface FakeSession {
	sessionFile?: string;
	sessionManager: { getEntries(): unknown[]; getCwd(): string };
	subscribe(listener: (event: FakeEvent) => void): () => void;
}

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/**
 * Let the fire-and-forget ingest promise (and its `finally`) settle.
 *
 * A macrotask yield drains the whole microtask queue, so this does not depend
 * on how many `await`s deep the ingest chain happens to be.
 */
async function tick(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0));
}

interface Harness {
	state: MempalaceSessionState;
	/** Targets handed to `runIngest`, in call order. */
	ingests: IngestTarget[];
	/** Emit a settled turn and let any triggered ingest run. */
	settle(): Promise<void>;
	user(text: string): Harness;
	assistant(text: string): Harness;
	/** Live `agent_end` subscriptions — guards against leaked listeners. */
	liveListeners(): number;
	markerPath: string;
	setIngestExit(exitCode: number): void;
}

function createHarness(opts: {
	agentDir: string;
	cwd: string;
	settings?: Record<string, unknown>;
	sessionFile?: string;
}): Harness {
	const entries: unknown[] = [];
	const listeners = new Set<(event: FakeEvent) => void>();
	const ingests: IngestTarget[] = [];
	let ingestExit = 0;

	const settingsMap = opts.settings ?? {};
	const session: FakeSession = {
		sessionFile: opts.sessionFile,
		sessionManager: {
			getEntries: () => entries,
			getCwd: () => opts.cwd,
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	const state = new MempalaceSessionState({
		session: session as unknown as AgentSession,
		settings: { get: (key: string) => settingsMap[key] } as unknown as Settings,
		agentDir: opts.agentDir,
		runIngest: async (target: IngestTarget): Promise<CliRunResult> => {
			ingests.push(target);
			return { exitCode: ingestExit, stdout: "", stderr: ingestExit === 0 ? "" : "boom", command: ["mine"] };
		},
	});

	const harness: Harness = {
		state,
		ingests,
		markerPath: path.join(opts.agentDir, MARKER_FILE),
		liveListeners: () => listeners.size,
		setIngestExit: code => {
			ingestExit = code;
		},
		user(text) {
			entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
			return harness;
		},
		assistant(text) {
			entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
			return harness;
		},
		async settle() {
			for (const listener of [...listeners]) listener({ type: "agent_end", messages: [] });
			await tick();
		},
	};
	return harness;
}

/** Drive `count` full user/assistant turns, settling after each. */
async function runTurns(harness: Harness, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		harness.user(`do the thing ${i}`);
		harness.assistant(`done ${i}`);
		await harness.settle();
	}
}

describe("MempalaceSessionState cadence", () => {
	it("triggers an ingest exactly on the configured interval, not before", async () => {
		const harness = createHarness({
			agentDir: await makeTempDir("omp-mp-state-"),
			cwd: "/projects/demo",
			settings: { "mempalace.ingestIntervalMessages": 3 },
		});
		harness.state.attach();

		await runTurns(harness, 2);
		expect(harness.ingests).toEqual([]);
		expect(harness.state.messagesSinceIngest).toBe(2);

		await runTurns(harness, 1);
		expect(harness.ingests).toHaveLength(1);
		expect(harness.state.messagesSinceIngest).toBe(0);
	});

	it("keeps firing every interval turns", async () => {
		const harness = createHarness({
			agentDir: await makeTempDir("omp-mp-state-"),
			cwd: "/projects/demo",
			settings: { "mempalace.ingestIntervalMessages": 2 },
		});
		harness.state.attach();

		await runTurns(harness, 6);
		expect(harness.ingests).toHaveLength(3);
	});

	it("defaults to a 15-turn interval when the setting is absent", async () => {
		const harness = createHarness({ agentDir: await makeTempDir("omp-mp-state-"), cwd: "/projects/demo" });
		harness.state.attach();

		await runTurns(harness, 14);
		expect(harness.ingests).toEqual([]);

		await runTurns(harness, 1);
		expect(harness.ingests).toHaveLength(1);
	});

	it("clamps a nonsensical interval to at least one turn", async () => {
		const harness = createHarness({
			agentDir: await makeTempDir("omp-mp-state-"),
			cwd: "/projects/demo",
			settings: { "mempalace.ingestIntervalMessages": 0 },
		});
		harness.state.attach();

		await runTurns(harness, 1);
		expect(harness.ingests).toHaveLength(1);
	});

	it("counts only substantive non-command user turns", async () => {
		const harness = createHarness({
			agentDir: await makeTempDir("omp-mp-state-"),
			cwd: "/projects/demo",
			settings: { "mempalace.ingestIntervalMessages": 2 },
		});
		harness.state.attach();

		harness.user("/plan the release");
		harness.user("!ls -la");
		harness.user("   ");
		harness.assistant("thinking out loud");
		await harness.settle();
		expect(harness.state.messagesSinceIngest).toBe(0);
		expect(harness.ingests).toEqual([]);

		// A leading path is a real message, not a slash command.
		harness.user("/home/charlie/notes.md please read this");
		await harness.settle();
		expect(harness.state.messagesSinceIngest).toBe(1);
		expect(harness.ingests).toEqual([]);

		harness.user("and now summarise it");
		await harness.settle();
		expect(harness.ingests).toHaveLength(1);
	});

	it("counts turns but ingests nothing when autoIngest is off", async () => {
		const harness = createHarness({
			agentDir: await makeTempDir("omp-mp-state-"),
			cwd: "/projects/demo",
			settings: { "mempalace.ingestIntervalMessages": 2, "mempalace.autoIngest": false },
		});
		harness.state.attach();

		await runTurns(harness, 4);
		expect(harness.ingests).toEqual([]);
		expect(harness.state.messagesSinceIngest).toBe(4);
	});

	it("ingests the session-file directory when one exists, else the cwd", async () => {
		const withSession = createHarness({
			agentDir: await makeTempDir("omp-mp-state-"),
			cwd: "/projects/demo",
			sessionFile: "/sessions/demo/session.jsonl",
			settings: { "mempalace.ingestIntervalMessages": 1 },
		});
		withSession.state.attach();
		await runTurns(withSession, 1);
		expect(withSession.ingests[0]).toEqual({ dir: "/sessions/demo", source: "session" });

		const withoutSession = createHarness({
			agentDir: await makeTempDir("omp-mp-state-"),
			cwd: "/projects/demo",
			settings: { "mempalace.ingestIntervalMessages": 1 },
		});
		withoutSession.state.attach();
		await runTurns(withoutSession, 1);
		expect(withoutSession.ingests[0]?.dir).toBe("/projects/demo");
	});

	it("survives a runIngest rejection without disturbing the cadence", async () => {
		const entries: unknown[] = [];
		const ingests: IngestTarget[] = [];
		let listener: ((event: FakeEvent) => void) | undefined;
		const session: FakeSession = {
			sessionManager: { getEntries: () => entries, getCwd: () => "/projects/demo" },
			subscribe(fn) {
				listener = fn;
				return () => {
					listener = undefined;
				};
			},
		};

		const state = new MempalaceSessionState({
			session: session as unknown as AgentSession,
			settings: {
				get: (key: string) => (key === "mempalace.ingestIntervalMessages" ? 1 : undefined),
			} as unknown as Settings,
			agentDir: await makeTempDir("omp-mp-state-"),
			runIngest: async (target: IngestTarget) => {
				ingests.push(target);
				throw new Error("python exploded");
			},
		});
		state.attach();

		entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "one" }] } });
		expect(() => listener?.({ type: "agent_end", messages: [] })).not.toThrow();
		await tick();

		entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "two" }] } });
		listener?.({ type: "agent_end", messages: [] });
		await tick();

		expect(ingests).toHaveLength(2);
	});
});

describe("MempalaceSessionState listener lifecycle", () => {
	it("attaches one listener and re-attaching does not stack subscriptions", async () => {
		const harness = createHarness({ agentDir: await makeTempDir("omp-mp-state-"), cwd: "/projects/demo" });
		expect(harness.liveListeners()).toBe(0);

		harness.state.attach();
		harness.state.attach();
		expect(harness.liveListeners()).toBe(1);
	});

	it("stops counting after detach", async () => {
		const harness = createHarness({
			agentDir: await makeTempDir("omp-mp-state-"),
			cwd: "/projects/demo",
			settings: { "mempalace.ingestIntervalMessages": 2 },
		});
		harness.state.attach();

		await runTurns(harness, 1);
		expect(harness.state.messagesSinceIngest).toBe(1);

		harness.state.detach();
		expect(harness.liveListeners()).toBe(0);

		await runTurns(harness, 5);
		expect(harness.state.messagesSinceIngest).toBe(1);
		expect(harness.ingests).toEqual([]);
	});

	it("detach is safe before attach and when called twice", async () => {
		const harness = createHarness({ agentDir: await makeTempDir("omp-mp-state-"), cwd: "/projects/demo" });
		expect(() => {
			harness.state.detach();
			harness.state.attach();
			harness.state.detach();
			harness.state.detach();
		}).not.toThrow();
		expect(harness.liveListeners()).toBe(0);
	});
});

describe("MempalaceSessionState local-memory import", () => {
	async function seedLocalMemory(agentDir: string, cwd: string, file = "MEMORY.md"): Promise<string> {
		const root = getMemoryRoot(agentDir, cwd);
		await fs.mkdir(root, { recursive: true });
		await Bun.write(path.join(root, file), "# remembered\n");
		return root;
	}

	it("does nothing when importLocalMemories is off", async () => {
		const agentDir = await makeTempDir("omp-mp-import-");
		const cwd = "/projects/alpha";
		await seedLocalMemory(agentDir, cwd);
		const harness = createHarness({ agentDir, cwd, settings: { "mempalace.importLocalMemories": false } });

		await harness.state.maybeImportLocalMemories();

		expect(harness.ingests).toEqual([]);
		expect(await Bun.file(harness.markerPath).exists()).toBe(false);
	});

	it("imports the project memory root once and records it in the marker", async () => {
		const agentDir = await makeTempDir("omp-mp-import-");
		const cwd = "/projects/alpha";
		const root = await seedLocalMemory(agentDir, cwd);
		const harness = createHarness({ agentDir, cwd, settings: { "mempalace.importLocalMemories": true } });

		await harness.state.maybeImportLocalMemories();
		expect(harness.ingests).toEqual([{ dir: root, source: "session" }]);
		expect((await Bun.file(harness.markerPath).text()).trim()).toBe(root);

		await harness.state.maybeImportLocalMemories();
		expect(harness.ingests).toHaveLength(1);
	});

	it("honors a marker written by an earlier session", async () => {
		const agentDir = await makeTempDir("omp-mp-import-");
		const cwd = "/projects/alpha";
		const root = await seedLocalMemory(agentDir, cwd);
		await Bun.write(path.join(agentDir, MARKER_FILE), `${root}\n`);
		const harness = createHarness({ agentDir, cwd, settings: { "mempalace.importLocalMemories": true } });

		await harness.state.maybeImportLocalMemories();

		expect(harness.ingests).toEqual([]);
	});

	it("treats learned.md alone as importable", async () => {
		const agentDir = await makeTempDir("omp-mp-import-");
		const cwd = "/projects/alpha";
		const root = await seedLocalMemory(agentDir, cwd, "learned.md");
		const harness = createHarness({ agentDir, cwd, settings: { "mempalace.importLocalMemories": true } });

		await harness.state.maybeImportLocalMemories();

		expect(harness.ingests).toEqual([{ dir: root, source: "session" }]);
	});

	it("stays eligible when the project has no local memory artifacts yet", async () => {
		const agentDir = await makeTempDir("omp-mp-import-");
		const cwd = "/projects/empty";
		const harness = createHarness({ agentDir, cwd, settings: { "mempalace.importLocalMemories": true } });

		await harness.state.maybeImportLocalMemories();
		expect(harness.ingests).toEqual([]);
		expect(await Bun.file(harness.markerPath).exists()).toBe(false);

		// Artifacts show up later; the next attempt must still import them.
		const root = await seedLocalMemory(agentDir, cwd);
		await harness.state.maybeImportLocalMemories();
		expect(harness.ingests).toEqual([{ dir: root, source: "session" }]);
	});

	it("retries after a failed import instead of marking it done", async () => {
		const agentDir = await makeTempDir("omp-mp-import-");
		const cwd = "/projects/alpha";
		const root = await seedLocalMemory(agentDir, cwd);
		const harness = createHarness({ agentDir, cwd, settings: { "mempalace.importLocalMemories": true } });
		harness.setIngestExit(1);

		await harness.state.maybeImportLocalMemories();
		expect(harness.ingests).toHaveLength(1);
		expect(await Bun.file(harness.markerPath).exists()).toBe(false);

		harness.setIngestExit(0);
		await harness.state.maybeImportLocalMemories();
		expect(harness.ingests).toHaveLength(2);
		expect((await Bun.file(harness.markerPath).text()).trim()).toBe(root);
	});

	it("marks per project, so one import does not block a sibling project", async () => {
		const agentDir = await makeTempDir("omp-mp-import-");
		const alphaRoot = await seedLocalMemory(agentDir, "/projects/alpha");
		const betaRoot = await seedLocalMemory(agentDir, "/projects/beta");
		const settings = { "mempalace.importLocalMemories": true };
		const alpha = createHarness({ agentDir, cwd: "/projects/alpha", settings });
		const beta = createHarness({ agentDir, cwd: "/projects/beta", settings });

		await alpha.state.maybeImportLocalMemories();
		await beta.state.maybeImportLocalMemories();

		expect(alpha.ingests).toEqual([{ dir: alphaRoot, source: "session" }]);
		expect(beta.ingests).toEqual([{ dir: betaRoot, source: "session" }]);

		const marker = await Bun.file(alpha.markerPath).text();
		expect(marker.split("\n").filter(Boolean).sort()).toEqual([alphaRoot, betaRoot].sort());

		// Both are recorded now; neither re-imports.
		await alpha.state.maybeImportLocalMemories();
		await beta.state.maybeImportLocalMemories();
		expect(alpha.ingests).toHaveLength(1);
		expect(beta.ingests).toHaveLength(1);
	});

	it("does not throw when the ingest itself rejects", async () => {
		const agentDir = await makeTempDir("omp-mp-import-");
		const cwd = "/projects/alpha";
		await seedLocalMemory(agentDir, cwd);
		const session: FakeSession = {
			sessionManager: { getEntries: () => [], getCwd: () => cwd },
			subscribe: () => () => {},
		};

		const state = new MempalaceSessionState({
			session: session as unknown as AgentSession,
			settings: { get: (key: string) => key === "mempalace.importLocalMemories" } as unknown as Settings,
			agentDir,
			runIngest: async () => {
				throw new Error("python exploded");
			},
		});

		await state.maybeImportLocalMemories();
		expect(await Bun.file(path.join(agentDir, MARKER_FILE)).exists()).toBe(false);
	});
});
