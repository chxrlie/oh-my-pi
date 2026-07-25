/**
 * Per-session state for the MemPalace memory backend: turn cadence and the
 * one-shot import of local-backend memory artifacts.
 *
 * Two deliberate non-goals:
 *
 * - **No prompt injection.** Unlike the mnemopi/hindsight states, nothing here
 *   ever recalls into the system prompt or appends a message. MemPalace is a
 *   write-side archive driven by `mempalace mine`; the model only reads it when
 *   it explicitly searches. Cadence work is therefore invisible to the turn.
 * - **No throwing.** Every entrypoint swallows its own failures. The backend is
 *   optional infrastructure layered over a Python package that may be absent,
 *   and a broken ingest must never surface as a failed agent turn.
 */

import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { extractMessages } from "../hindsight/transcript";
import { getMemoryRoot } from "../memories";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { CliRunResult } from "./cli";
import { resolveIngestTarget } from "./policies";
import type { IngestTarget } from "./types";

/** Fallback when `mempalace.ingestIntervalMessages` is unset or nonsensical. */
const DEFAULT_INGEST_INTERVAL = 15;

/**
 * Marker recording which project memory roots have already been imported.
 *
 * Lives at `<agentDir>/.mempalace-imported` and holds one absolute memory-root
 * path per line. The file is per-agent-dir but the *decision* is per-project:
 * one omp install serves many projects, so a plain boolean marker would let the
 * first project to import permanently block every other one.
 */
const IMPORT_MARKER_FILE = ".mempalace-imported";

/** Local-backend artifacts worth importing; presence of either triggers a run. */
const LOCAL_MEMORY_FILES = ["MEMORY.md", "learned.md"] as const;

/**
 * A user turn that is really a command invocation rather than a conversational
 * message: a leading `/` (slash command) or `!` (bash escape) followed by a
 * bare command token.
 *
 * The trailing `(?:\s|$)` is what keeps `/home/user/notes.md please read this`
 * out of the command bucket — a path's next character is `/`, not whitespace.
 * Miscounting here only shifts the ingest cadence by a turn, so the predicate
 * errs toward counting anything ambiguous as a real message.
 */
const COMMAND_TURN_RE = /^[/!][a-zA-Z0-9_-]*(?:\s|$)/;

/**
 * Session-scoped cadence driver for the MemPalace backend.
 *
 * Counts substantive, non-command user turns as they settle and hands the
 * ingest target to `runIngest` every `mempalace.ingestIntervalMessages` turns.
 * `runIngest` is injected rather than imported so tests never need Python.
 */
export class MempalaceSessionState {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	readonly #agentDir: string;
	readonly #runIngest: (target: IngestTarget) => Promise<CliRunResult>;

	#unsubscribe: (() => void) | undefined;
	/** Non-command user turns observed so far. */
	#userTurns = 0;
	/** Value of {@link #userTurns} when the last ingest was triggered. */
	#lastIngestedTurn = 0;
	/** True while a background ingest is running; keeps runs from overlapping. */
	#ingestInFlight = false;

	constructor(opts: {
		session: AgentSession;
		settings: Settings;
		agentDir: string;
		runIngest: (target: IngestTarget) => Promise<CliRunResult>;
	}) {
		this.#session = opts.session;
		this.#settings = opts.settings;
		this.#agentDir = opts.agentDir;
		this.#runIngest = opts.runIngest;
	}

	/**
	 * Subscribe to session events and start counting turns.
	 *
	 * Idempotent: re-attaching drops the previous subscription first, so a
	 * double `start()` cannot double-count a turn.
	 */
	attach(): void {
		this.detach();
		this.#unsubscribe = this.#session.subscribe((event: AgentSessionEvent) => {
			if (event.type !== "agent_end") return;
			this.#onAgentEnd();
		});
	}

	/** Drop the session subscription. Idempotent; safe before `attach()`. */
	detach(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	/** Non-command user turns since the last ingest trigger. */
	get messagesSinceIngest(): number {
		return Math.max(0, this.#userTurns - this.#lastIngestedTurn);
	}

	/**
	 * Import the project's local-backend memory into the palace exactly once.
	 *
	 * Gated on `mempalace.importLocalMemories`. Reads nothing and writes nothing
	 * under the local memory root — `mempalace mine` is a pure reader, so
	 * `MEMORY.md` / `learned.md` survive untouched and the local backend keeps
	 * working if the user switches back.
	 *
	 * The marker is only written after a clean run, and only when there was
	 * something to import: a project with no memory artifacts yet stays eligible
	 * for a later session, and a failed ingest is retried rather than silently
	 * abandoned.
	 */
	async maybeImportLocalMemories(): Promise<void> {
		try {
			if (this.#settings.get("mempalace.importLocalMemories") !== true) return;

			const markerPath = path.join(this.#agentDir, IMPORT_MARKER_FILE);
			const root = getMemoryRoot(this.#agentDir, this.#session.sessionManager.getCwd());
			const imported = await readImportMarker(markerPath);
			if (imported.has(root)) return;
			if (!(await hasLocalMemoryArtifacts(root))) return;

			// `source: "session"` — an omp-managed directory, deliberate rather
			// than the unsafe `cwd` last resort. This is a one-shot import, not a
			// preservation run, so `isPreservationSatisfied` never sees it.
			const result = await this.#runIngest({ dir: root, source: "session" });
			if (result.exitCode !== 0) {
				logger.warn("MemPalace: local-memory import failed", {
					dir: root,
					exitCode: result.exitCode,
					stderr: result.stderr.slice(0, 500),
				});
				return;
			}

			imported.add(root);
			await Bun.write(markerPath, `${[...imported].join("\n")}\n`);
			logger.debug("MemPalace: imported local memories", { dir: root });
		} catch (error) {
			logger.warn("MemPalace: local-memory import errored", { error: String(error) });
		}
	}

	/**
	 * Recount user turns and fire an ingest when the interval has elapsed.
	 *
	 * Counting is unconditional so `messagesSinceIngest` stays meaningful (and
	 * status output stays honest) even with `mempalace.autoIngest` off.
	 */
	#onAgentEnd(): void {
		this.#userTurns = this.#countUserTurns();
		if (this.#settings.get("mempalace.autoIngest") === false) return;
		if (this.messagesSinceIngest < this.#ingestInterval()) return;
		// A slow ingest holds the cursor back rather than queueing a second run;
		// the next settled turn retries.
		if (this.#ingestInFlight) return;

		this.#lastIngestedTurn = this.#userTurns;
		this.#ingestInFlight = true;
		void this.#ingest(this.#resolveTarget()).finally(() => {
			this.#ingestInFlight = false;
		});
	}

	async #ingest(target: IngestTarget): Promise<void> {
		try {
			const result = await this.#runIngest(target);
			if (result.exitCode !== 0) {
				logger.debug("MemPalace: background ingest failed", {
					dir: target.dir,
					exitCode: result.exitCode,
					stderr: result.stderr.slice(0, 500),
				});
			}
		} catch (error) {
			logger.debug("MemPalace: background ingest errored", { dir: target.dir, error: String(error) });
		}
	}

	/**
	 * Count substantive, non-command user turns in the current branch.
	 *
	 * Recounted from the session manager on every settle rather than
	 * incremented, which keeps the cursor correct across branch, rewind, and
	 * session switch — the same reason mnemopi's `maybeRetainOnAgentEnd` does it.
	 */
	#countUserTurns(): number {
		try {
			let count = 0;
			for (const message of extractMessages(this.#session.sessionManager)) {
				if (message.role !== "user") continue;
				if (COMMAND_TURN_RE.test(message.content.trimStart())) continue;
				count++;
			}
			return count;
		} catch (error) {
			logger.debug("MemPalace: user-turn count failed", { error: String(error) });
			return this.#userTurns;
		}
	}

	#ingestInterval(): number {
		const configured = this.#settings.get("mempalace.ingestIntervalMessages");
		if (typeof configured !== "number" || !Number.isFinite(configured)) return DEFAULT_INGEST_INTERVAL;
		return Math.max(1, Math.floor(configured));
	}

	#resolveTarget(): IngestTarget {
		const sessionFile = this.#session.sessionFile;
		return resolveIngestTarget({
			sessionFileDir: sessionFile ? path.dirname(sessionFile) : undefined,
			cwd: this.#session.sessionManager.getCwd(),
		});
	}
}

async function hasLocalMemoryArtifacts(root: string): Promise<boolean> {
	for (const name of LOCAL_MEMORY_FILES) {
		if (await Bun.file(path.join(root, name)).exists()) return true;
	}
	return false;
}

/** Read the marker, tolerating an absent or unreadable file as "nothing imported". */
async function readImportMarker(markerPath: string): Promise<Set<string>> {
	const text = await Bun.file(markerPath)
		.text()
		.catch(() => "");
	const roots = new Set<string>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) roots.add(trimmed);
	}
	return roots;
}
