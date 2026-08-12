/**
 * Child half of the native palace mine, loaded inside the subprocess the CLI
 * boots through `MEMPALACE_MINE_WORKER_ARG`.
 *
 * Everything expensive lives here: the directory walk, the per-file read, the
 * SHA-256 and the chunking are all synchronous, so running them on the agent's
 * thread would stall the turn loop for the whole mine and make the parent's
 * `AbortSignal` decorative. The parent keeps only the ledger diff and the vault
 * writes.
 *
 * Two invariants the parent may rely on:
 *
 *  - `plan` is stat-only. It opens nothing, hashes nothing and chunks nothing,
 *    which is what makes it safe for Smart Mining to call before every
 *    scheduled run.
 *  - Every `file` message carries at least one non-empty chunk, and is followed
 *    by silence until the parent's `ack` arrives. A slow vault throttles the
 *    walk instead of queueing chunked file bodies in the parent's heap.
 *
 * Diagnostics go out as protocol `log` messages rather than through the shared
 * logger: this is a child address space, and the parent is the only place the
 * lines are useful.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { chunkText } from "./chunk";
import { ALWAYS_SKIP_DIRS, createIgnoreMatcher, type IgnoreMatcher, isAlwaysSkippedFile } from "./ignore";
import type { MineWorkerInbound, MineWorkerOutbound, MineWorkerTransport } from "./mine-protocol";
import type { MinedFilePayload, MineMode, MinePlan, MineWorkerPlanRequest } from "./types";

/**
 * Sustained end-to-end throughput of the per-file pipeline — read, SHA-256,
 * paragraph chunk — on a warm page cache, in bytes per millisecond (~40 MiB/s).
 * Deliberately conservative: the scheduler would rather over-estimate and defer
 * than start a mine it cannot finish inside its slice.
 */
const MINE_BYTES_PER_MILLI = 40 * 1024;
/** Per-file overhead independent of size: the open, the ledger lookup, the IPC round-trip. */
const MINE_MILLIS_PER_FILE = 1.5;

/** Applied only when the parent sends a nonsensical bound; it normally resolves both itself. */
const FALLBACK_MAX_FILE_BYTES = 512 * 1024;
const FALLBACK_MAX_FILES = 2000;

/** A NUL inside the first page is the cheapest reliable "this is not text" signal. */
const BINARY_PROBE_BYTES = 4096;
/** `MineResult.warnings` is a diagnostic, not a log; past this it is only noise. */
const MAX_WARNINGS = 20;
/** One turn of a transcript past this length is a paste, not a conversation. */
const MAX_CONVO_TEXT_CHARS = 4000;
const MAX_CONVO_TITLE_CHARS = 80;

const ROOT_ROOM = "root";
const CONVO_ROOM = "sessions";
/** The one dot-directory worth mining: CI workflows and issue templates are authored prose. */
const DOT_DIR_EXCEPTION = ".github";

/** Source and prose extensions worth chunking in `project` mode. */
const PROJECT_TEXT_EXTENSIONS: Readonly<Record<string, true>> = {
	".ts": true,
	".tsx": true,
	".js": true,
	".jsx": true,
	".mjs": true,
	".cjs": true,
	".py": true,
	".rs": true,
	".go": true,
	".java": true,
	".kt": true,
	".rb": true,
	".php": true,
	".c": true,
	".h": true,
	".cpp": true,
	".hpp": true,
	".cs": true,
	".swift": true,
	".sh": true,
	".sql": true,
	".md": true,
	".mdx": true,
	".txt": true,
	".rst": true,
	".toml": true,
	".yaml": true,
	".yml": true,
	".json": true,
};

/**
 * Transcript extensions for `convos` mode. Harness session logs are JSONL, so
 * the source allowlist above would miss every one of them — the two modes read
 * different kinds of file and need different allowlists.
 */
const CONVO_EXTENSIONS: Readonly<Record<string, true>> = {
	".jsonl": true,
	".json": true,
	".ndjson": true,
};

/** Roles whose records carry machinery rather than conversation. */
const DROPPED_ROLES: Readonly<Record<string, true>> = {
	tool: true,
	tool_result: true,
	system: true,
};

/** Keys that hold the record list when a session file is a single JSON object. */
const RECORD_CONTAINER_KEYS: readonly string[] = ["messages", "entries", "records", "conversation", "turns"];

interface Candidate {
	path: string;
	size: number;
	mtimeMs: number;
	/** `false` when the ledger already covers this exact size and mtime. */
	changed: boolean;
}

interface WalkContext {
	readonly root: string;
	readonly mode: MineMode;
	readonly maxFileBytes: number;
	readonly maxFiles: number;
	readonly ledger: Record<string, string>;
	readonly force: boolean;
	readonly matcher: IgnoreMatcher;
	readonly warn: (message: string) => void;
	/** Candidates yielded so far, measured against `maxFiles`. */
	seen: number;
	/** Set when the walk stopped short, so every count derived from it is a lower bound. */
	truncated: boolean;
}

/** Counters a run keeps while turning candidates into payloads. */
interface RunReporter {
	/** A candidate that produced nothing. `reason` is recorded while there is warning room. */
	skip(reason?: string): void;
	/** A non-fatal problem that did not cost a whole file. */
	warn(reason: string): void;
}

interface ConvoTurn {
	role: string;
	text: string;
}

export function startMempalaceMineWorker(transport: MineWorkerTransport): void {
	/**
	 * Acks received with no run parked on them. An in-process transport can
	 * deliver `ack` synchronously from inside `send`, before the run reaches its
	 * `await`; latching the credit instead of dropping it is what keeps that
	 * ordering from deadlocking the walk.
	 */
	let ackCredit = 0;
	let ackWaiter: (() => void) | null = null;
	let cancelRequested = false;
	let running = false;

	const emit = (message: MineWorkerOutbound): void => {
		try {
			transport.send(message);
		} catch {
			// The parent is gone or the channel is closed. Nothing we send now
			// can reach it, and throwing here would take the worker down.
		}
	};

	const receiveAck = (): void => {
		const waiter = ackWaiter;
		if (waiter === null) {
			ackCredit++;
			return;
		}
		ackWaiter = null;
		waiter();
	};

	const waitForAck = (): Promise<void> => {
		if (ackCredit > 0) {
			ackCredit--;
			return Promise.resolve();
		}
		return new Promise<void>(resolve => {
			ackWaiter = resolve;
		});
	};

	const handlePlan = (message: Extract<MineWorkerInbound, { type: "plan" }>): void => {
		try {
			const warnings: string[] = [];
			const plan = buildPlan(message.request, reason => {
				if (warnings.length < MAX_WARNINGS) warnings.push(reason);
			});
			for (const warning of warnings) emit({ type: "log", level: "debug", msg: `mine plan: ${warning}` });
			emit({ type: "plan", id: message.id, plan });
		} catch (error) {
			emit({ type: "error", id: message.id, error: errorMessage(error) });
		}
	};

	const handleRun = async (message: Extract<MineWorkerInbound, { type: "run" }>): Promise<void> => {
		if (running) {
			// Two concurrent runs would interleave `file` messages and break the
			// one-outstanding-ack invariant the whole handshake rests on.
			emit({ type: "error", id: message.id, error: "mine worker is already running a mine" });
			emit({
				type: "done",
				id: message.id,
				summary: { filesScanned: 0, filesSkipped: 0, filesUnchanged: 0, completed: false, warnings: [] },
			});
			return;
		}
		running = true;
		cancelRequested = false;
		ackCredit = 0;
		ackWaiter = null;

		const request = message.request;
		const started = Date.now();
		const warnings: string[] = [];
		let filesScanned = 0;
		let filesSkipped = 0;
		let filesUnchanged = 0;
		let completed = true;

		const reporter: RunReporter = {
			skip(reason) {
				filesSkipped++;
				// Past the cap the text is dropped but the file stays counted, so
				// the overflow is still visible in `filesSkipped`.
				if (reason !== undefined && warnings.length < MAX_WARNINGS) warnings.push(reason);
			},
			warn(reason) {
				if (warnings.length < MAX_WARNINGS) warnings.push(reason);
			},
		};

		// Resolving the target and loading its ignore rules happens inside the
		// try: a malformed request must still produce a terminal message rather
		// than a rejected promise and a worker stuck in `running`.
		let mode: MineMode = "project";
		try {
			const root = path.resolve(request.dir);
			const ctx = createWalkContext(request, root, reporter.warn);
			mode = ctx.mode;
			for (const candidate of walkDirectory(ctx, root)) {
				if (cancelRequested) {
					completed = false;
					break;
				}
				if (request.budgetMillis > 0 && Date.now() - started >= request.budgetMillis) {
					completed = false;
					break;
				}
				if (!candidate.changed) {
					filesUnchanged++;
					continue;
				}
				const file =
					ctx.mode === "convos"
						? buildConvoPayload(root, candidate, reporter)
						: buildProjectPayload(root, candidate, reporter);
				if (file === null) continue;

				filesScanned++;
				emit({ type: "file", id: message.id, file });
				await waitForAck();
				if (cancelRequested) {
					completed = false;
					break;
				}
				// Hand the loop back so a `cancel` queued behind this file is
				// actually delivered before the next one is read.
				await new Promise<void>(resolve => {
					setImmediate(resolve);
				});
			}
			if (ctx.truncated) completed = false;
		} catch (error) {
			// A bad file must not kill the worker, and the parent must still get
			// a terminal message for this id, so both go out.
			emit({ type: "error", id: message.id, error: errorMessage(error) });
			completed = false;
		} finally {
			running = false;
			cancelRequested = false;
			ackWaiter = null;
			ackCredit = 0;
		}

		emit({
			type: "log",
			level: "debug",
			msg: "mine run finished",
			meta: { mode, filesScanned, filesSkipped, filesUnchanged, completed },
		});
		emit({
			type: "done",
			id: message.id,
			summary: { filesScanned, filesSkipped, filesUnchanged, completed, warnings },
		});
	};

	transport.onMessage(message => {
		switch (message.type) {
			case "ping":
				emit({ type: "pong", id: message.id });
				return;
			case "plan":
				handlePlan(message);
				return;
			case "run":
				void handleRun(message);
				return;
			case "ack":
				// Any ack releases the single outstanding file. Matching it against
				// the run id would deadlock the whole mine the moment the parent
				// used a different id convention, which is far worse than
				// tolerating a stale ack from a run that already ended.
				receiveAck();
				return;
			case "cancel":
				cancelRequested = true;
				// Release a run parked on an ack that is never coming.
				receiveAck();
				return;
		}
	});
}

function buildPlan(request: MineWorkerPlanRequest, warn: (message: string) => void): MinePlan {
	const root = path.resolve(request.dir);
	const ctx = createWalkContext(request, root, warn);
	let candidateFiles = 0;
	let changedFiles = 0;
	let changedBytes = 0;
	for (const candidate of walkDirectory(ctx, root)) {
		candidateFiles++;
		if (!candidate.changed) continue;
		changedFiles++;
		changedBytes += candidate.size;
	}
	return {
		mode: ctx.mode,
		candidateFiles,
		changedFiles,
		unchangedFiles: candidateFiles - changedFiles,
		changedBytes,
		estimatedMillis: Math.round(changedFiles * MINE_MILLIS_PER_FILE + changedBytes / MINE_BYTES_PER_MILLI),
		truncated: ctx.truncated,
	};
}

function createWalkContext(request: MineWorkerPlanRequest, root: string, warn: (message: string) => void): WalkContext {
	return {
		root,
		mode: request.mode === "convos" ? "convos" : "project",
		maxFileBytes: request.maxFileBytes > 0 ? request.maxFileBytes : FALLBACK_MAX_FILE_BYTES,
		maxFiles: request.maxFiles > 0 ? request.maxFiles : FALLBACK_MAX_FILES,
		ledger: request.ledger ?? {},
		force: request.force === true,
		matcher: createIgnoreMatcher(root),
		warn,
		seen: 0,
		truncated: false,
	};
}

/**
 * Stat-only enumeration of mine candidates, depth-first and name-ordered so a
 * budget-limited run resumes over the same sequence. Both `plan` and `run`
 * drive this generator, which is what makes the pre-flight estimate describe
 * the run that follows it.
 */
function* walkDirectory(ctx: WalkContext, dir: string): Generator<Candidate> {
	if (ctx.seen >= ctx.maxFiles) {
		ctx.truncated = true;
		return;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		ctx.warn(`${relPath(ctx.root, dir)}: unreadable directory (${errorMessage(error)})`);
		return;
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	for (const entry of entries) {
		if (ctx.seen >= ctx.maxFiles) {
			ctx.truncated = true;
			return;
		}
		const name = entry.name;
		const abs = path.join(dir, name);
		// Symlinks are skipped outright: following them invites cycles and
		// double-mining, and neither is worth a visited-inode set here.
		if (entry.isSymbolicLink()) continue;

		if (entry.isDirectory()) {
			if (name.startsWith(".") && name !== DOT_DIR_EXCEPTION) continue;
			if (ALWAYS_SKIP_DIRS[name] === true) continue;
			if (ctx.matcher(abs, true)) continue;
			yield* walkDirectory(ctx, abs);
			continue;
		}
		if (!entry.isFile()) continue;
		if (name.startsWith(".")) continue;
		if (isAlwaysSkippedFile(name)) continue;

		const extension = path.extname(name).toLowerCase();
		const allowed = ctx.mode === "convos" ? CONVO_EXTENSIONS : PROJECT_TEXT_EXTENSIONS;
		if (allowed[extension] !== true) continue;
		if (ctx.matcher(abs, false)) continue;

		let size: number;
		let mtimeMs: number;
		try {
			const stat = fs.statSync(abs);
			size = stat.size;
			// Rounded so the ledger key is stable across the JSON round-trip and
			// the parent's SQLite column; the parent never stats, so this value
			// is the only definition of the file's mtime either side sees.
			mtimeMs = Math.round(stat.mtimeMs);
		} catch (error) {
			ctx.warn(`${relPath(ctx.root, abs)}: unreadable (${errorMessage(error)})`);
			continue;
		}
		if (size > ctx.maxFileBytes) continue;

		ctx.seen++;
		yield { path: abs, size, mtimeMs, changed: ctx.force || ctx.ledger[abs] !== `${size}:${mtimeMs}` };
	}
}

function buildProjectPayload(root: string, candidate: Candidate, reporter: RunReporter): MinedFilePayload | null {
	const label = relPath(root, candidate.path);
	let buffer: Buffer;
	try {
		buffer = fs.readFileSync(candidate.path);
	} catch (error) {
		reporter.skip(`${label}: unreadable (${errorMessage(error)})`);
		return null;
	}
	if (looksBinary(buffer)) {
		reporter.skip(`${label}: binary content`);
		return null;
	}

	const chunks = chunkText(buffer.toString("utf8"));
	if (chunks.length === 0) {
		// Empty or whitespace-only source. Common enough (`__init__.py`) that a
		// warning would drown the real ones, but it still yields no drawer.
		reporter.skip();
		return null;
	}
	return {
		path: candidate.path,
		size: candidate.size,
		mtimeMs: candidate.mtimeMs,
		contentHash: createHash("sha256").update(buffer).digest("hex"),
		room: roomFor(root, candidate.path),
		chunks,
	};
}

function buildConvoPayload(root: string, candidate: Candidate, reporter: RunReporter): MinedFilePayload | null {
	const label = path.basename(candidate.path);
	let buffer: Buffer;
	try {
		buffer = fs.readFileSync(candidate.path);
	} catch (error) {
		reporter.skip(`${relPath(root, candidate.path)}: unreadable (${errorMessage(error)})`);
		return null;
	}
	if (looksBinary(buffer)) {
		reporter.skip(`${label}: binary content`);
		return null;
	}

	const records = parseSessionRecords(buffer.toString("utf8"), line =>
		reporter.warn(`${label}:${line}: unparseable JSON`),
	);
	const lines: string[] = [];
	let firstUserText = "";
	for (const record of records) {
		const turn = extractTurn(record);
		if (turn === null) continue;
		lines.push(`${turn.role}: ${turn.text}`);
		if (firstUserText.length === 0 && turn.role === "user") firstUserText = turn.text;
	}
	if (lines.length === 0) {
		reporter.skip(`${label}: no usable session records`);
		return null;
	}

	const headline = firstUserText.replace(/\s+/g, " ").trim();
	const rawTitle = headline.length > 0 ? `${label} — ${headline}` : label;
	return {
		path: candidate.path,
		size: candidate.size,
		mtimeMs: candidate.mtimeMs,
		contentHash: createHash("sha256").update(buffer).digest("hex"),
		room: CONVO_ROOM,
		// One session is one memory: the transcript stays whole rather than
		// being scattered across chunks that each lose the thread.
		chunks: [
			{
				title: rawTitle.length > MAX_CONVO_TITLE_CHARS ? rawTitle.slice(0, MAX_CONVO_TITLE_CHARS).trim() : rawTitle,
				body: lines.join("\n"),
			},
		],
	};
}

/**
 * Read a session file as either JSONL or one whole JSON value. A line that will
 * not parse is reported and dropped — a truncated log is the normal end state
 * of a killed session, not a reason to lose the rest of the transcript.
 */
function parseSessionRecords(text: string, onBadLine: (lineNumber: number) => void): unknown[] {
	const trimmed = text.trim();
	if (trimmed.length === 0) return [];

	if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return parsed;
			if (isRecord(parsed)) {
				for (const key of RECORD_CONTAINER_KEYS) {
					const nested = parsed[key];
					if (Array.isArray(nested)) return nested;
				}
			}
			return [parsed];
		} catch {
			// Multiple JSON values in one file: that is JSONL, handled below.
		}
	}

	// Split the original text, not the trimmed copy, so a reported line number
	// still points at the right line of the file.
	const records: unknown[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line.length === 0) continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			onBadLine(i + 1);
		}
	}
	return records;
}

function extractTurn(record: unknown): ConvoTurn | null {
	if (!isRecord(record)) return null;
	// Harness entries wrap the real message (`{ type: "message", message: {…} }`),
	// so the inner object wins wherever it has an opinion.
	const inner = isRecord(record.message) ? record.message : undefined;
	const rawRole = firstString(inner?.role, record.role, inner?.type, record.type, record.sender);
	if (rawRole === undefined) return null;

	// Fold `toolResult`, `tool-result` and `tool_result` onto one spelling.
	const role = rawRole
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[\s-]+/g, "_")
		.toLowerCase();
	if (DROPPED_ROLES[role] === true) return null;

	const text = extractText(inner?.content ?? record.content).trim();
	if (text.length === 0) return null;
	return {
		role,
		text: text.length > MAX_CONVO_TEXT_CHARS ? `${text.slice(0, MAX_CONVO_TEXT_CHARS).trimEnd()}…` : text,
	};
}

/** Content is either a bare string or an array of parts, only some of which carry text. */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			parts.push(part);
			continue;
		}
		if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return undefined;
}

function looksBinary(buffer: Buffer): boolean {
	const probe = buffer.length < BINARY_PROBE_BYTES ? buffer.length : BINARY_PROBE_BYTES;
	return buffer.subarray(0, probe).indexOf(0) !== -1;
}

/** Directory of `filePath` relative to the mine root; the top level is `root`. */
function roomFor(root: string, filePath: string): string {
	const relative = path.relative(root, path.dirname(filePath));
	if (relative.length === 0 || relative === "." || relative.startsWith("..")) return ROOT_ROOM;
	return relative.split(path.sep).join("/");
}

function relPath(root: string, target: string): string {
	const relative = path.relative(root, target);
	if (relative.length === 0 || relative.startsWith("..")) return path.basename(target);
	return relative.split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
