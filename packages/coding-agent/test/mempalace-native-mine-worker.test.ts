import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chunkText } from "../src/mempalace-native/chunk";
import {
	ALWAYS_SKIP_DIRS,
	createIgnoreMatcher,
	isAlwaysSkippedFile,
	LOCKFILE_PATTERNS,
} from "../src/mempalace-native/ignore";
import type { MineWorkerInbound, MineWorkerOutbound, MineWorkerTransport } from "../src/mempalace-native/mine-protocol";
import { startMempalaceMineWorker } from "../src/mempalace-native/mine-worker";
import type {
	MinedFilePayload,
	MinePlan,
	MineRunSummary,
	MineWorkerPlanRequest,
	MineWorkerRunRequest,
} from "../src/mempalace-native/types";

/**
 * Mine worker contract, plus the two pure modules it walks on. No subprocess is
 * ever spawned: `startMempalaceMineWorker` takes a transport, so an in-process
 * fake driving that transport observes the `file` → `ack` handshake message by
 * message and controls exactly when the walk is allowed to advance.
 */

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 2000;
/** Mirrors `MAX_WARNINGS` in the worker, which is private to it. */
const WARNING_CAP = 20;
/** Mirrors `MAX_CONVO_TEXT_CHARS` / `MAX_CONVO_TITLE_CHARS`, also private. */
const CONVO_TEXT_CAP = 4000;
const CONVO_TITLE_CAP = 80;

/**
 * Event-loop turns a driven run may take before the test gives up. Each mined
 * file costs a couple of turns (the worker hands the loop back through
 * `setImmediate` between files), so this is generous for the fixtures here and
 * still fails a stalled handshake in milliseconds instead of hanging the suite.
 */
const MAX_DRIVE_STEPS = 500;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mp-mine-"));
	tempDirs.push(dir);
	return dir;
}

/** A temp tree from `relative path → contents`; intermediate directories are created. */
function makeTree(files: Record<string, string | Buffer>): string {
	const root = makeTempDir();
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(root, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	return root;
}

/** The ledger value the worker compares against: `size:mtimeMs`, mtime rounded. */
function ledgerEntryFor(file: string): string {
	const stat = fs.statSync(file);
	return `${stat.size}:${Math.round(stat.mtimeMs)}`;
}

function planRequest(dir: string, overrides: Partial<MineWorkerPlanRequest> = {}): MineWorkerPlanRequest {
	return {
		dir,
		mode: "project",
		maxFileBytes: DEFAULT_MAX_FILE_BYTES,
		maxFiles: DEFAULT_MAX_FILES,
		ledger: {},
		force: false,
		...overrides,
	};
}

function runRequest(dir: string, overrides: Partial<MineWorkerRunRequest> = {}): MineWorkerRunRequest {
	return { ...planRequest(dir), budgetMillis: 0, ...overrides };
}

// ---------------------------------------------------------------------------
// chunk.ts
// ---------------------------------------------------------------------------

describe("chunkText", () => {
	test("splits on paragraph boundaries and packs whole paragraphs up to maxChars", () => {
		// Each paragraph is 47 characters, so exactly two fit a 120-char budget
		// (47 + 2 + 47 = 96) and a third never does (96 + 2 + 47 = 145).
		const paragraphs = Array.from({ length: 10 }, (_unused, index) => `para-${index} ${"x".repeat(40)}`);
		const chunks = chunkText(paragraphs.join("\n\n"), { maxChars: 120, overlapChars: 0 });

		expect(chunks).toHaveLength(5);
		for (const [index, chunk] of chunks.entries()) {
			expect(chunk.body).toBe(`${paragraphs[index * 2]}\n\n${paragraphs[index * 2 + 1]}`);
			expect(chunk.body.length).toBeLessThanOrEqual(120);
			expect(chunk.title).toBe(paragraphs[index * 2]);
		}
	});

	test("keeps a blank line with trailing whitespace as a paragraph boundary", () => {
		const chunks = chunkText("alpha\n   \n\nbeta\n\n\n\ngamma", { maxChars: 16, overlapChars: 0 });

		expect(chunks.map(chunk => chunk.body)).toEqual(["alpha\n\nbeta", "gamma"]);
	});

	test("derives a title from the first non-empty line, stripping heading and comment punctuation", () => {
		const cases: [input: string, title: string][] = [
			["# Heading\n\nbody", "Heading"],
			["### Deep heading ###", "Deep heading"],
			["// line comment title", "line comment title"],
			["/* block comment title */", "block comment title"],
			["<!-- html comment title -->", "html comment title"],
			["- bullet title", "bullet title"],
			["> quoted title", "quoted title"],
			['"""docstring title"""', "docstring title"],
			["; ini comment title", "ini comment title"],
			["/** # nested opener", "nested opener"],
			["plain first line\nsecond line", "plain first line"],
			["\n\n   \nafter blank lines", "after blank lines"],
		];

		for (const [input, title] of cases) {
			expect(chunkText(input)[0]?.title).toBe(title);
		}
	});

	test("caps a derived title at 80 characters", () => {
		const chunks = chunkText(`# ${"a".repeat(100)}`);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].title).toBe("a".repeat(80));
		// The cap is on the title only; the body keeps every character.
		expect(chunks[0].body).toBe(`# ${"a".repeat(100)}`);
	});

	test("falls back to a positional title when the first line is pure decoration", () => {
		const chunks = chunkText("alphabetagamma\n\n-----", { maxChars: 16, overlapChars: 0 });

		expect(chunks.map(chunk => chunk.title)).toEqual(["alphabetagamma", "chunk 2"]);
		expect(chunks[1].body).toBe("-----");
	});

	test("falls back from paragraphs to whole lines for an oversized paragraph", () => {
		const paragraph = ["aaaa", "bbbb", "cccc", "dddd", "eeee"].join("\n");
		const chunks = chunkText(paragraph, { maxChars: 20, overlapChars: 0 });

		expect(chunks.map(chunk => chunk.body)).toEqual(["aaaa\nbbbb\ncccc\ndddd", "eeee"]);
	});

	test("falls back to a hard cut for a single oversized line", () => {
		const chunks = chunkText("z".repeat(50), { maxChars: 20, overlapChars: 0 });

		expect(chunks.map(chunk => chunk.body.length)).toEqual([20, 20, 10]);
		expect(chunks.map(chunk => chunk.body).join("")).toBe("z".repeat(50));
	});

	test("clamps a nonsensical maxChars up to the 16-character floor", () => {
		const chunks = chunkText("z".repeat(30), { maxChars: 4 });

		expect(chunks.map(chunk => chunk.body.length)).toEqual([16, 14]);
	});

	test("carries an overlap tail into the next chunk when it still fits", () => {
		const chunks = chunkText("one two three four five\n\nsix", { maxChars: 24, overlapChars: 10 });

		// The tail is advanced to a token boundary rather than cut mid-word.
		expect(chunks.map(chunk => chunk.body)).toEqual(["one two three four five", "four five\n\nsix"]);
	});

	test("drops the overlap when it would push the next chunk over budget", () => {
		const chunks = chunkText("one two three four five\n\nsixteen chars!!", { maxChars: 24, overlapChars: 10 });

		expect(chunks.map(chunk => chunk.body)).toEqual(["one two three four five", "sixteen chars!!"]);
	});

	test("never emits an empty or whitespace-only chunk", () => {
		const inputs = [
			"",
			"   ",
			"\n\n\n",
			"\t \n \t",
			"\r\n\r\n",
			"---",
			"# \n\n# \n",
			"a\n\n\n\n\n\nb",
			"\r\n# windows\r\n\r\n   \r\n\r\nbody\r\n",
		];

		for (const input of inputs) {
			for (const chunk of chunkText(input)) {
				expect(chunk.body.length).toBeGreaterThan(0);
				expect(chunk.body).toBe(chunk.body.trim());
				expect(chunk.title.length).toBeGreaterThan(0);
			}
		}
		expect(chunkText("")).toEqual([]);
		expect(chunkText("   \n\t\n  ")).toEqual([]);
		expect(chunkText("\r\n\r\n")).toEqual([]);
		expect(chunkText(undefined as unknown as string)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// ignore.ts
// ---------------------------------------------------------------------------

describe("createIgnoreMatcher", () => {
	test("anchors a leading-slash pattern to the directory holding the ignore file", () => {
		const root = makeTree({ ".gitignore": "/top.md\n" });
		const matcher = createIgnoreMatcher(root);

		expect(matcher(path.join(root, "top.md"), false)).toBe(true);
		expect(matcher(path.join(root, "sub", "top.md"), false)).toBe(false);
	});

	test("matches an unanchored pattern at any depth", () => {
		const root = makeTree({ ".gitignore": "notes.md\n" });
		const matcher = createIgnoreMatcher(root);

		expect(matcher(path.join(root, "notes.md"), false)).toBe(true);
		expect(matcher(path.join(root, "sub", "deep", "notes.md"), false)).toBe(true);
		expect(matcher(path.join(root, "sub", "other.md"), false)).toBe(false);
	});

	test("applies a trailing-slash pattern to directories only", () => {
		const root = makeTree({ ".gitignore": "logs/\n" });
		const matcher = createIgnoreMatcher(root);

		expect(matcher(path.join(root, "logs"), true)).toBe(true);
		// A *file* of the same name is not what the rule speaks about.
		expect(matcher(path.join(root, "logs"), false)).toBe(false);
		// Nothing beneath an excluded directory can be reached again.
		expect(matcher(path.join(root, "logs", "today.md"), false)).toBe(true);
	});

	test("keeps * inside one segment and lets ** span them", () => {
		const root = makeTree({ ".gitignore": "docs/*.md\ndocs/**/draft.txt\n" });
		const matcher = createIgnoreMatcher(root);

		expect(matcher(path.join(root, "docs", "a.md"), false)).toBe(true);
		expect(matcher(path.join(root, "docs", "deep", "a.md"), false)).toBe(false);
		// `**/` absorbs its own slash, so the zero-directory case still matches.
		expect(matcher(path.join(root, "docs", "draft.txt"), false)).toBe(true);
		expect(matcher(path.join(root, "docs", "deep", "nested", "draft.txt"), false)).toBe(true);
	});

	test("lets the last matching rule win, negation included", () => {
		const negateLast = makeTree({ ".gitignore": "*.log\n!keep.log\n" });
		const first = createIgnoreMatcher(negateLast);
		expect(first(path.join(negateLast, "debug.log"), false)).toBe(true);
		expect(first(path.join(negateLast, "keep.log"), false)).toBe(false);

		// Same two rules, opposite order: the trailing `*.log` re-ignores it.
		const negateFirst = makeTree({ ".gitignore": "!keep.log\n*.log\n" });
		const second = createIgnoreMatcher(negateFirst);
		expect(second(path.join(negateFirst, "keep.log"), false)).toBe(true);
	});

	test("loads a nested .gitignore and lets it override the root", () => {
		const root = makeTree({ ".gitignore": "*.md\n", "sub/.gitignore": "!keep.md\nsecret.md\n" });
		const matcher = createIgnoreMatcher(root);

		expect(matcher(path.join(root, "top.md"), false)).toBe(true);
		expect(matcher(path.join(root, "sub", "keep.md"), false)).toBe(false);
		expect(matcher(path.join(root, "sub", "secret.md"), false)).toBe(true);
	});

	test("ignores comments and blank lines", () => {
		const root = makeTree({ ".gitignore": "# a comment\n\n   \nreal.md\n" });
		const matcher = createIgnoreMatcher(root);

		expect(matcher(path.join(root, "real.md"), false)).toBe(true);
		expect(matcher(path.join(root, "a comment"), false)).toBe(false);
	});

	test("never skips the root itself or anything outside it", () => {
		const root = makeTree({ ".gitignore": "*\n" });
		const matcher = createIgnoreMatcher(root);

		expect(matcher(root, true)).toBe(false);
		expect(matcher(path.dirname(root), true)).toBe(false);
	});
});

describe("always-skipped files and directories", () => {
	test("flags a sample of every lockfile pattern", () => {
		/** One filename per shipped pattern, so a new pattern fails this test. */
		const samples: Record<string, string> = {
			"*.lock": "Cargo.lock",
			"package-lock.json": "package-lock.json",
			"bun.lock": "bun.lock",
			"bun.lockb": "bun.lockb",
			"*.min.js": "app.min.js",
		};

		expect(Object.keys(samples).sort()).toEqual([...LOCKFILE_PATTERNS].sort());
		for (const name of Object.values(samples)) {
			expect(isAlwaysSkippedFile(name)).toBe(true);
		}
	});

	test("leaves authored source files alone", () => {
		for (const name of ["index.js", "lock.json", "notes.md", "minified.ts", "lockfile.txt"]) {
			expect(isAlwaysSkippedFile(name)).toBe(false);
		}
	});

	test("lists node_modules and the usual build output as never-walked directories", () => {
		for (const name of ["node_modules", ".git", "dist", "build", "out", "target", "vendor", "__pycache__"]) {
			expect(ALWAYS_SKIP_DIRS[name]).toBe(true);
		}
	});

	test("skips a node_modules file through the matcher even with no ignore file", () => {
		const root = makeTree({ "keep.js": "export const a = 1;\n" });
		const matcher = createIgnoreMatcher(root);

		expect(matcher(path.join(root, "node_modules"), true)).toBe(true);
		expect(matcher(path.join(root, "node_modules", "pkg", "index.js"), false)).toBe(true);
		expect(matcher(path.join(root, "package-lock.json"), false)).toBe(true);
		expect(matcher(path.join(root, "keep.js"), false)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// mine-worker.ts — in-process transport and run driver
// ---------------------------------------------------------------------------

interface WorkerHarness {
	/** Every outbound message, in send order. */
	sent: MineWorkerOutbound[];
	/** Push one inbound message into the worker's handler, synchronously. */
	deliver(message: MineWorkerInbound): void;
	/** Outbound messages of one type, in send order. */
	ofType<T extends MineWorkerOutbound["type"]>(type: T): Extract<MineWorkerOutbound, { type: T }>[];
	/** `file` payloads streamed for one request id. */
	filesFor(id: string): MinedFilePayload[];
	/** The terminal summary for one request id, once it has arrived. */
	doneFor(id: string): MineRunSummary | undefined;
	/** `error` texts reported for one request id. */
	errorsFor(id: string): string[];
	/** Live `onMessage` subscriptions — guards against a leaked or duplicated handler. */
	liveHandlers(): number;
}

/**
 * Boot a worker on a hand-rolled transport.
 *
 * `autoAck` answers every `file` from inside `send`, which is the re-entrant
 * ordering an in-process parent produces: the ack lands before the run reaches
 * its `await`, so the worker has to latch the credit rather than drop it.
 */
function createWorker(options: { autoAck?: boolean } = {}): WorkerHarness {
	const sent: MineWorkerOutbound[] = [];
	const handlers: ((message: MineWorkerInbound) => void)[] = [];

	const deliver = (message: MineWorkerInbound): void => {
		if (handlers.length === 0) throw new Error("mine worker registered no message handler");
		for (const handler of [...handlers]) handler(message);
	};

	const transport: MineWorkerTransport = {
		send(message) {
			sent.push(message);
			if (options.autoAck === true && message.type === "file") deliver({ type: "ack", id: message.id });
		},
		onMessage(handler) {
			handlers.push(handler);
			return () => {
				const index = handlers.indexOf(handler);
				if (index >= 0) handlers.splice(index, 1);
			};
		},
	};

	startMempalaceMineWorker(transport);

	const harness: WorkerHarness = {
		sent,
		deliver,
		ofType<T extends MineWorkerOutbound["type"]>(type: T) {
			return sent.filter((message): message is Extract<MineWorkerOutbound, { type: T }> => message.type === type);
		},
		filesFor(id) {
			return harness
				.ofType("file")
				.filter(message => message.id === id)
				.map(message => message.file);
		},
		doneFor(id) {
			return harness.ofType("done").find(message => message.id === id)?.summary;
		},
		errorsFor(id) {
			return harness
				.ofType("error")
				.filter(message => message.id === id)
				.map(message => message.error);
		},
		liveHandlers() {
			return handlers.length;
		},
	};
	return harness;
}

/**
 * One macrotask turn. The worker hands the loop back through `setImmediate`
 * between files, so a microtask flush would never advance a driven run.
 */
function flush(): Promise<void> {
	return new Promise<void>(resolve => {
		setImmediate(resolve);
	});
}

/** Turn the event loop until `id` reports `done`, or fail rather than hang. */
async function pump(harness: WorkerHarness, id: string, step?: () => Promise<void>): Promise<MineRunSummary> {
	for (let turn = 0; turn < MAX_DRIVE_STEPS; turn++) {
		if (step !== undefined) await step();
		const done = harness.doneFor(id);
		if (done !== undefined) return done;
		await flush();
	}
	throw new Error(`mine run "${id}" did not finish within ${MAX_DRIVE_STEPS} turns`);
}

interface DriveOptions {
	/** Request id; every `file`, `error` and `done` of this run carries it. */
	id?: string;
	/** Runs before the file at `index` is answered — a place to stall or to assert. */
	beforeAck?: (file: MinedFilePayload, index: number) => Promise<void> | void;
	/** Answer the file at `index` with something other than `ack`. */
	respondWith?: (index: number) => "ack" | "cancel";
}

/**
 * Inject `run` and drive the handshake to completion: answer each `file` as it
 * appears, turn the loop, and resolve on `done`.
 */
async function driveRun(
	harness: WorkerHarness,
	request: MineWorkerRunRequest,
	options: DriveOptions = {},
): Promise<MineRunSummary> {
	const id = options.id ?? "run-1";
	let answered = 0;

	harness.deliver({ type: "run", id, request });
	return await pump(harness, id, async () => {
		while (answered < harness.filesFor(id).length) {
			const index = answered;
			const file = harness.filesFor(id)[index];
			answered++;
			if (options.beforeAck !== undefined) await options.beforeAck(file, index);
			harness.deliver({ type: options.respondWith?.(index) ?? "ack", id });
		}
	});
}

/** `plan` is fully synchronous, so its reply is on the wire the moment `deliver` returns. */
function requestPlan(harness: WorkerHarness, request: MineWorkerPlanRequest, id = "plan-1"): MinePlan {
	harness.deliver({ type: "plan", id, request });
	const replies = harness.ofType("plan").filter(message => message.id === id);
	if (replies.length !== 1) throw new Error(`expected one plan reply for "${id}", got ${replies.length}`);
	return replies[0].plan;
}

const HOSTILE_MESSAGE = "hostile request: dir is unreadable";

/** A request that throws the moment a handler touches `dir`, i.e. inside the handler's own try. */
function hostileRequest(): MineWorkerRunRequest {
	return {
		get dir(): string {
			throw new Error(HOSTILE_MESSAGE);
		},
		mode: "project",
		maxFileBytes: DEFAULT_MAX_FILE_BYTES,
		maxFiles: DEFAULT_MAX_FILES,
		ledger: {},
		force: false,
		budgetMillis: 0,
	};
}

describe("mine worker protocol", () => {
	test("answers ping with pong on a single registered handler", () => {
		const harness = createWorker();

		expect(harness.liveHandlers()).toBe(1);
		harness.deliver({ type: "ping", id: "ping-1" });
		harness.deliver({ type: "ping", id: "ping-2" });

		expect(harness.sent).toEqual([
			{ type: "pong", id: "ping-1" },
			{ type: "pong", id: "ping-2" },
		]);
	});

	test("reports a plan handler failure as an error and keeps serving", () => {
		const harness = createWorker();

		harness.deliver({ type: "plan", id: "plan-bad", request: hostileRequest() });

		expect(harness.errorsFor("plan-bad")).toEqual([HOSTILE_MESSAGE]);
		expect(harness.ofType("plan")).toHaveLength(0);

		harness.deliver({ type: "ping", id: "after" });
		expect(harness.ofType("pong").map(message => message.id)).toEqual(["after"]);
	});

	test("reports a run handler failure as an error, still sends done, and keeps serving", async () => {
		const harness = createWorker();

		const summary = await driveRun(harness, hostileRequest(), { id: "run-bad" });

		expect(harness.errorsFor("run-bad")).toEqual([HOSTILE_MESSAGE]);
		expect(summary).toEqual({
			filesScanned: 0,
			filesSkipped: 0,
			filesUnchanged: 0,
			completed: false,
			warnings: [],
		});

		harness.deliver({ type: "ping", id: "after" });
		expect(harness.ofType("pong").map(message => message.id)).toEqual(["after"]);
	});

	test("refuses a second run while one is parked on an ack", async () => {
		const dir = makeTree({ "a.md": "alpha\n", "b.md": "beta\n" });
		const harness = createWorker();

		harness.deliver({ type: "run", id: "first", request: runRequest(dir) });
		expect(harness.filesFor("first")).toHaveLength(1);

		harness.deliver({ type: "run", id: "second", request: runRequest(dir) });
		expect(harness.errorsFor("second")).toEqual(["mine worker is already running a mine"]);
		expect(harness.doneFor("second")?.completed).toBe(false);
		expect(harness.filesFor("second")).toHaveLength(0);

		// The refusal did not disturb the run that was already in flight. The
		// counter matters: re-acking a file the worker already consumed would
		// bank credit and let the walk run ahead of this driver.
		harness.deliver({ type: "ack", id: "first" });
		let answered = 1;
		const summary = await pump(harness, "first", async () => {
			while (answered < harness.filesFor("first").length) {
				answered++;
				harness.deliver({ type: "ack", id: "first" });
			}
		});
		expect(summary.filesScanned).toBe(2);
		expect(summary.completed).toBe(true);
	});
});

describe("mine worker plan", () => {
	test("is stat-only: it counts candidates whose bytes it never reads", async () => {
		const dir = makeTree({
			"readable.md": "readable body\n",
			// A NUL plus a lone 0xff: invalid UTF-8, and provably binary to anything that reads it.
			"binary.md": Buffer.from([0x68, 0x69, 0x00, 0xff, 0xfe, 0x0a]),
			// Mode 000: a read would throw EACCES, so a plan that survives it
			// cannot have opened it. Only a real barrier for a non-root runner,
			// hence the count-free run assertions below — do not tighten them.
			"locked.md": "content behind mode 000\n",
		});
		fs.chmodSync(path.join(dir, "locked.md"), 0o000);
		const harness = createWorker();

		const plan = requestPlan(harness, planRequest(dir));

		expect(plan.mode).toBe("project");
		expect(plan.candidateFiles).toBe(3);
		expect(plan.changedFiles).toBe(3);
		expect(plan.unchangedFiles).toBe(0);
		expect(plan.truncated).toBe(false);
		expect(plan.changedBytes).toBe(
			["readable.md", "binary.md", "locked.md"].reduce(
				(total, name) => total + fs.statSync(path.join(dir, name)).size,
				0,
			),
		);
		expect(Number.isInteger(plan.estimatedMillis)).toBe(true);
		expect(plan.estimatedMillis).toBeGreaterThan(0);
		// Stat-only also means no per-file streaming and no diagnostics beyond the plan.
		expect(harness.ofType("file")).toHaveLength(0);
		expect(harness.ofType("error")).toHaveLength(0);

		// The differential: the run *does* read, and drops what the plan counted.
		const summary = await driveRun(harness, runRequest(dir));
		const mined = harness.filesFor("run-1").map(file => file.path);
		expect(mined).toContain(path.join(dir, "readable.md"));
		expect(mined).not.toContain(path.join(dir, "binary.md"));
		expect(summary.warnings).toContain("binary.md: binary content");
	});

	test("splits changed from unchanged against the supplied ledger", () => {
		const dir = makeTree({ "alpha.md": "alpha body\n", "beta.md": "beta body\n", "gamma.md": "gamma body\n" });
		const harness = createWorker();
		const ledger = {
			[path.join(dir, "alpha.md")]: ledgerEntryFor(path.join(dir, "alpha.md")),
			[path.join(dir, "beta.md")]: ledgerEntryFor(path.join(dir, "beta.md")),
		};

		const plan = requestPlan(harness, planRequest(dir, { ledger }));

		expect(plan.candidateFiles).toBe(3);
		expect(plan.changedFiles).toBe(1);
		expect(plan.unchangedFiles).toBe(2);
		expect(plan.changedBytes).toBe(fs.statSync(path.join(dir, "gamma.md")).size);
	});

	test("treats a stale ledger entry as changed", () => {
		const dir = makeTree({ "alpha.md": "alpha body\n" });
		const harness = createWorker();
		const ledger = { [path.join(dir, "alpha.md")]: "1:1" };

		expect(requestPlan(harness, planRequest(dir, { ledger })).changedFiles).toBe(1);
	});

	test("reclassifies every candidate as changed under force", () => {
		const dir = makeTree({ "alpha.md": "alpha body\n", "beta.md": "beta body\n", "gamma.md": "gamma body\n" });
		const harness = createWorker();
		const ledger = Object.fromEntries(
			["alpha.md", "beta.md", "gamma.md"].map(name => [path.join(dir, name), ledgerEntryFor(path.join(dir, name))]),
		);

		expect(requestPlan(harness, planRequest(dir, { ledger }), "clean").changedFiles).toBe(0);

		const forced = requestPlan(harness, planRequest(dir, { ledger, force: true }), "forced");
		expect(forced.candidateFiles).toBe(3);
		expect(forced.changedFiles).toBe(3);
		expect(forced.unchangedFiles).toBe(0);
	});

	test("marks the counts truncated when maxFiles cuts the walk short", async () => {
		const dir = makeTree({ "a.md": "alpha\n", "b.md": "beta\n", "c.md": "gamma\n" });
		const harness = createWorker();

		const plan = requestPlan(harness, planRequest(dir, { maxFiles: 2 }));
		expect(plan.candidateFiles).toBe(2);
		expect(plan.truncated).toBe(true);

		// The same ceiling makes a run incomplete, so the scheduler resumes it.
		const summary = await driveRun(harness, runRequest(dir, { maxFiles: 2 }));
		expect(summary.filesScanned).toBe(2);
		expect(summary.completed).toBe(false);
	});
});

describe("mine worker run", () => {
	test("emits one file per changed file and blocks until each ack arrives", async () => {
		const dir = makeTree({ "a.md": "alpha body\n", "b.md": "beta body\n", "c.md": "gamma body\n" });
		const harness = createWorker();
		const observed: number[] = [];

		const summary = await driveRun(harness, runRequest(dir), {
			beforeAck: async (_file, index) => {
				// While the first file is unacked the walk must not advance, no
				// matter how many turns of the loop go by.
				if (index === 0) {
					for (let turn = 0; turn < 5; turn++) await flush();
					expect(harness.filesFor("run-1")).toHaveLength(1);
				}
				observed.push(harness.filesFor("run-1").length);
			},
		});

		expect(summary).toEqual({
			filesScanned: 3,
			filesSkipped: 0,
			filesUnchanged: 0,
			completed: true,
			warnings: [],
		});
		// One outstanding file at every ack: the walk never ran ahead of the parent.
		expect(observed).toEqual([1, 2, 3]);
		expect(harness.filesFor("run-1").map(file => path.basename(file.path))).toEqual(["a.md", "b.md", "c.md"]);
		expect(harness.ofType("done")).toHaveLength(1);
	});

	test("carries the full payload for a mined file", async () => {
		const dir = makeTree({ "keep.md": "keep me\n" });
		const harness = createWorker();
		const target = path.join(dir, "keep.md");

		await driveRun(harness, runRequest(dir));

		expect(harness.filesFor("run-1")).toEqual([
			{
				path: target,
				size: fs.statSync(target).size,
				mtimeMs: Math.round(fs.statSync(target).mtimeMs),
				contentHash: createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
				room: "root",
				chunks: [{ title: "keep me", body: "keep me" }],
			},
		]);
	});

	test("excludes binary, oversized, non-allowlisted and gitignored files", async () => {
		const dir = makeTree({
			".gitignore": "ignored.md\n",
			"keep.md": "keep me\n",
			"binary.md": Buffer.from([0x68, 0x69, 0x00, 0x0a]),
			"huge.md": "x".repeat(400),
			"notes.rtf": "not an allowlisted extension\n",
			"ignored.md": "ignored body\n",
			"node_modules/pkg/index.js": "module.exports = 1;\n",
			"package-lock.json": '{"lockfileVersion":3}\n',
			"app.min.js": "var a=1;\n",
		});
		const harness = createWorker();

		// Everything but the binary file is refused by the stat-only walk itself.
		expect(requestPlan(harness, planRequest(dir, { maxFileBytes: 256 })).candidateFiles).toBe(2);

		const summary = await driveRun(harness, runRequest(dir, { maxFileBytes: 256 }));

		expect(harness.filesFor("run-1").map(file => path.basename(file.path))).toEqual(["keep.md"]);
		expect(summary.filesScanned).toBe(1);
		expect(summary.filesSkipped).toBe(1);
		expect(summary.filesUnchanged).toBe(0);
		expect(summary.completed).toBe(true);
		expect(summary.warnings).toEqual(["binary.md: binary content"]);
	});

	test("honours a nested .gitignore and derives the room from the directory", async () => {
		const dir = makeTree({
			".gitignore": "ignored.md\n",
			"keep.md": "top body\n",
			"ignored.md": "ignored body\n",
			"sub/.gitignore": "nested-skip.md\n",
			"sub/keep2.md": "nested body\n",
			"sub/nested-skip.md": "skipped body\n",
			"sub/deep/keep3.md": "deep body\n",
		});
		const harness = createWorker();

		const summary = await driveRun(harness, runRequest(dir));

		expect(harness.filesFor("run-1").map(file => [path.relative(dir, file.path), file.room])).toEqual([
			["keep.md", "root"],
			[path.join("sub", "deep", "keep3.md"), "sub/deep"],
			[path.join("sub", "keep2.md"), "sub"],
		]);
		expect(summary.filesScanned).toBe(3);
		expect(summary.filesSkipped).toBe(0);
	});

	test("skips ledger-unchanged files and re-mines them under force", async () => {
		const dir = makeTree({ "alpha.md": "alpha body\n", "beta.md": "beta body\n" });
		const ledger = { [path.join(dir, "alpha.md")]: ledgerEntryFor(path.join(dir, "alpha.md")) };

		const incremental = createWorker();
		const summary = await driveRun(incremental, runRequest(dir, { ledger }));
		expect(incremental.filesFor("run-1").map(file => path.basename(file.path))).toEqual(["beta.md"]);
		expect(summary.filesScanned).toBe(1);
		expect(summary.filesUnchanged).toBe(1);

		const forced = createWorker();
		const forcedSummary = await driveRun(forced, runRequest(dir, { ledger, force: true }));
		expect(forced.filesFor("run-1").map(file => path.basename(file.path))).toEqual(["alpha.md", "beta.md"]);
		expect(forcedSummary.filesScanned).toBe(2);
		expect(forcedSummary.filesUnchanged).toBe(0);
	});

	test("stops on cancel with a partial, incomplete summary", async () => {
		const dir = makeTree({ "a.md": "alpha\n", "b.md": "beta\n", "c.md": "gamma\n" });
		const harness = createWorker();

		const summary = await driveRun(harness, runRequest(dir), {
			respondWith: index => (index === 0 ? "cancel" : "ack"),
		});

		expect(summary.completed).toBe(false);
		expect(summary.filesScanned).toBe(1);
		expect(harness.filesFor("run-1").map(file => path.basename(file.path))).toEqual(["a.md"]);
		expect(harness.ofType("done")).toHaveLength(1);
	});

	test("accepts a fresh run after a cancelled one", async () => {
		const dir = makeTree({ "a.md": "alpha\n", "b.md": "beta\n" });
		const harness = createWorker();

		await driveRun(harness, runRequest(dir), { id: "cancelled", respondWith: () => "cancel" });
		expect(harness.doneFor("cancelled")?.completed).toBe(false);

		const summary = await driveRun(harness, runRequest(dir), { id: "retry" });
		expect(summary.completed).toBe(true);
		expect(summary.filesScanned).toBe(2);
	});

	test("stops on the wall-clock budget with an incomplete summary", async () => {
		const dir = makeTree({ "a.md": "alpha\n", "b.md": "beta\n", "c.md": "gamma\n" });

		const unbounded = createWorker();
		const control = await driveRun(unbounded, runRequest(dir));
		expect(control.completed).toBe(true);
		expect(control.filesScanned).toBe(3);

		// Same tree, same acks — only the clock moves. `setSystemTime` alone (no
		// fake timers) keeps `setImmediate` real, which the handshake driver and
		// the worker's own inter-file yield both depend on.
		const budgeted = createWorker();
		let clock = Date.now();
		setSystemTime(new Date(clock));
		const summary = await driveRun(budgeted, runRequest(dir, { budgetMillis: 50 }), {
			beforeAck: () => {
				clock += 500;
				setSystemTime(new Date(clock));
			},
		}).finally(() => {
			setSystemTime();
		});

		expect(summary.completed).toBe(false);
		expect(summary.filesScanned).toBe(1);
		expect(budgeted.filesFor("run-1")).toHaveLength(1);
	});

	test("caps warnings at 20 while still counting every skipped file", async () => {
		const files: Record<string, string | Buffer> = { "good.md": "good body\n" };
		for (let index = 0; index < 25; index++) {
			files[`bin-${String(index).padStart(2, "0")}.md`] = Buffer.from([0x61, 0x00, 0x62]);
		}
		const harness = createWorker();

		const summary = await driveRun(harness, runRequest(makeTree(files)));

		expect(summary.filesSkipped).toBe(25);
		expect(summary.warnings).toHaveLength(WARNING_CAP);
		expect(summary.warnings[0]).toBe("bin-00.md: binary content");
		expect(summary.warnings[WARNING_CAP - 1]).toBe("bin-19.md: binary content");
		// The overflow is dropped as text but still visible in the counter.
		expect(summary.filesScanned).toBe(1);
		expect(summary.completed).toBe(true);
	});

	test("tolerates an ack delivered synchronously from inside send", async () => {
		const dir = makeTree({ "a.md": "alpha\n", "b.md": "beta\n", "c.md": "gamma\n" });
		const harness = createWorker({ autoAck: true });

		harness.deliver({ type: "run", id: "sync", request: runRequest(dir) });
		const summary = await pump(harness, "sync");

		expect(summary.filesScanned).toBe(3);
		expect(summary.completed).toBe(true);
		expect(harness.filesFor("sync")).toHaveLength(3);
	});

	test("survives an unwalkable directory and a transport that throws on send", async () => {
		const dir = makeTree({ "a.md": "alpha\n" });
		const harness = createWorker();

		const summary = await driveRun(harness, runRequest(path.join(dir, "does-not-exist")));

		expect(summary.filesScanned).toBe(0);
		expect(summary.completed).toBe(true);
		expect(summary.warnings).toHaveLength(1);
		expect(summary.warnings[0]).toContain("unreadable directory");
	});
});

describe("mine worker convos mode", () => {
	const alphaLines = [
		JSON.stringify({ role: "user", content: "how do I ship this?" }),
		JSON.stringify({ role: "system", content: "you are a helpful assistant" }),
		JSON.stringify({ role: "assistant", content: "run the build" }),
		JSON.stringify({ role: "tool", content: "exit 0" }),
		JSON.stringify({ role: "toolResult", content: "ok" }),
		JSON.stringify({ role: "tool-result", content: "also ok" }),
		JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "done" }, { type: "image" }, "tail"] },
		}),
	];

	function convoTree(): string {
		return makeTree({
			"alpha.jsonl": `${alphaLines.join("\n")}\n`,
			"beta.json": JSON.stringify([
				{ role: "user", content: "array form" },
				{ role: "assistant", content: "understood" },
			]),
			"silent.json": JSON.stringify([
				{ role: "system", content: "nothing usable" },
				{ role: "tool", content: "noise" },
			]),
		});
	}

	test("counts every transcript extension as a plan candidate", () => {
		const harness = createWorker();

		const plan = requestPlan(harness, planRequest(convoTree(), { mode: "convos" }));

		expect(plan.mode).toBe("convos");
		expect(plan.candidateFiles).toBe(3);
		expect(plan.changedFiles).toBe(3);
	});

	test("turns each session file into one role-prefixed transcript payload", async () => {
		const dir = convoTree();
		const harness = createWorker();

		const summary = await driveRun(harness, runRequest(dir, { mode: "convos" }));
		const files = harness.filesFor("run-1");

		expect(files.map(file => path.basename(file.path))).toEqual(["alpha.jsonl", "beta.json"]);
		for (const file of files) {
			expect(file.room).toBe("sessions");
			expect(file.chunks).toHaveLength(1);
			expect(file.contentHash).toBe(createHash("sha256").update(fs.readFileSync(file.path)).digest("hex"));
		}

		// JSONL, with `system`, `tool`, `toolResult` and `tool-result` all dropped
		// and an array-of-parts content flattened.
		expect(files[0].chunks[0]).toEqual({
			title: "alpha.jsonl — how do I ship this?",
			body: "user: how do I ship this?\nassistant: run the build\nassistant: done\ntail",
		});
		// A single JSON array is the same transcript by another spelling.
		expect(files[1].chunks[0]).toEqual({
			title: "beta.json — array form",
			body: "user: array form\nassistant: understood",
		});

		// The all-machinery file yields nothing, and says so.
		expect(summary.filesScanned).toBe(2);
		expect(summary.filesSkipped).toBe(1);
		expect(summary.completed).toBe(true);
		expect(summary.warnings).toEqual(["silent.json: no usable session records"]);
	});

	test("unwraps a records container in a single JSON object", async () => {
		const dir = makeTree({
			"wrapped.json": JSON.stringify({
				version: 3,
				messages: [
					{ role: "user", content: "wrapped question" },
					{ role: "assistant", content: "wrapped answer" },
				],
			}),
		});
		const harness = createWorker();

		await driveRun(harness, runRequest(dir, { mode: "convos" }));

		expect(harness.filesFor("run-1")[0].chunks[0].body).toBe("user: wrapped question\nassistant: wrapped answer");
	});

	test("warns about a malformed JSONL line without failing the run", async () => {
		const dir = makeTree({
			"session.jsonl": [
				JSON.stringify({ role: "user", content: "first" }),
				'{"role":"assistant","content":',
				JSON.stringify({ role: "assistant", content: "second" }),
			].join("\n"),
		});
		const harness = createWorker();

		const summary = await driveRun(harness, runRequest(dir, { mode: "convos" }));

		expect(summary.completed).toBe(true);
		expect(summary.filesScanned).toBe(1);
		// A dropped line is a warning, not a skipped file.
		expect(summary.filesSkipped).toBe(0);
		expect(summary.warnings).toEqual(["session.jsonl:2: unparseable JSON"]);
		expect(harness.filesFor("run-1")[0].chunks[0].body).toBe("user: first\nassistant: second");
	});

	test("caps an oversized turn and an oversized title", async () => {
		const dir = makeTree({
			"long.jsonl": [
				JSON.stringify({ role: "user", content: "q".repeat(5000) }),
				JSON.stringify({ role: "assistant", content: "short" }),
			].join("\n"),
		});
		const harness = createWorker();

		await driveRun(harness, runRequest(dir, { mode: "convos" }));
		const chunk = harness.filesFor("run-1")[0].chunks[0];
		const lines = chunk.body.split("\n");

		expect(lines[0]).toBe(`user: ${"q".repeat(CONVO_TEXT_CAP)}…`);
		expect(lines[1]).toBe("assistant: short");
		expect(chunk.title).toHaveLength(CONVO_TITLE_CAP);
		expect(chunk.title).toBe(`long.jsonl — ${"q".repeat(CONVO_TITLE_CAP - "long.jsonl — ".length)}`);
	});

	test("ignores source files that are not transcripts", async () => {
		const dir = makeTree({
			"notes.md": "prose the convos allowlist must not touch\n",
			"session.jsonl": JSON.stringify({ role: "user", content: "only me" }),
		});
		const harness = createWorker();

		const summary = await driveRun(harness, runRequest(dir, { mode: "convos" }));

		expect(harness.filesFor("run-1").map(file => path.basename(file.path))).toEqual(["session.jsonl"]);
		expect(summary.filesScanned).toBe(1);
	});
});
