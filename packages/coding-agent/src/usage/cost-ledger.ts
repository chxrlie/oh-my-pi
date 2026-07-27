/**
 * Local SQLite ledger of token spend and estimated cost, attributed per
 * project (WakaTime-compatible project name, see `./project-resolver`).
 *
 * Storage:
 *   One process-wide connection opens lazily on first append and stays open.
 *   Every helper swallows open/IO failures and degrades to "no ledger" — this
 *   sits on the per-assistant-message path, so a corrupt, read-only or locked
 *   DB must never surface as an error in the session loop.
 *
 * Privacy:
 *   Purely local. Nothing here is ever transmitted; the rows hold a project
 *   name, a session id, a model/provider pair, token counts and a USD figure.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getUsageLedgerDbPath, logger } from "@oh-my-pi/pi-utils";

const SCHEMA_VERSION = 1;

export interface LedgerEntry {
	recordedAt: number;
	project: string;
	sessionId: string | undefined;
	model: string;
	provider: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
}

export interface ProjectTotals {
	project: string;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	sessions: number;
	firstRecordedAt: number;
	lastRecordedAt: number;
}

export interface ModelTotals {
	model: string;
	provider: string;
	costUsd: number;
	totalTokens: number;
	requests: number;
}

interface ProjectRow {
	project: string;
	cost_usd: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	sessions: number | null;
	first_recorded_at: number | null;
	last_recorded_at: number | null;
}

interface ModelRow {
	model: string;
	provider: string;
	cost_usd: number | null;
	total_tokens: number | null;
	requests: number | null;
}

let cachedDb: Database | null = null;
let openAttempted = false;

function ensureParentDir(filePath: string): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	} catch (err) {
		logger.debug("usage ledger: failed to create private parent dir", { err: String(err) });
	}
}

function chmodIfExists(filePath: string, mode: number): void {
	try {
		fs.chmodSync(filePath, mode);
	} catch (err) {
		const code = err instanceof Error && "code" in err ? err.code : undefined;
		if (code !== "ENOENT") {
			logger.debug("usage ledger: chmod failed", { err: String(err), path: filePath });
		}
	}
}

function protectDbFiles(dbPath: string): void {
	chmodIfExists(dbPath, 0o600);
	chmodIfExists(`${dbPath}-wal`, 0o600);
	chmodIfExists(`${dbPath}-shm`, 0o600);
}

/**
 * Open (or reuse) the ledger connection. Returns null once an open has failed
 * so a broken path is not retried on every single assistant message.
 */
function openDb(): Database | null {
	if (cachedDb) return cachedDb;
	if (openAttempted) return null;
	openAttempted = true;
	try {
		const dbPath = getUsageLedgerDbPath();
		ensureParentDir(dbPath);
		const db = new Database(dbPath);
		// Install the busy handler BEFORE any lock-taking statement, otherwise a
		// concurrent omp process holding the write lock fails us instantly.
		db.run("PRAGMA busy_timeout = 5000");
		db.run(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=NORMAL;
		`);
		db.run(`
			CREATE TABLE IF NOT EXISTS usage_ledger (
				id                 INTEGER PRIMARY KEY AUTOINCREMENT,
				recorded_at        INTEGER NOT NULL,
				project            TEXT    NOT NULL,
				session_id         TEXT,
				model              TEXT    NOT NULL,
				provider           TEXT    NOT NULL,
				input_tokens       INTEGER NOT NULL DEFAULT 0,
				output_tokens      INTEGER NOT NULL DEFAULT 0,
				cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
				cache_write_tokens INTEGER NOT NULL DEFAULT 0,
				cost_usd           REAL    NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS idx_usage_ledger_project_recorded ON usage_ledger(project, recorded_at);
			CREATE INDEX IF NOT EXISTS idx_usage_ledger_recorded ON usage_ledger(recorded_at);
			PRAGMA user_version = ${SCHEMA_VERSION};
		`);
		protectDbFiles(dbPath);
		cachedDb = db;
		return db;
	} catch (err) {
		logger.debug("usage ledger: failed to open DB; ledger disabled", { err: String(err) });
		return null;
	}
}

/** Coerce to a finite non-negative integer; SQLite rejects NaN/Infinity binds. */
function tokenCount(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.round(value);
}

/** Coerce to a finite cost; negatives are meaningless here but cheap to clamp. */
function usd(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return value;
}

const INSERT_SQL = `
	INSERT INTO usage_ledger (
		recorded_at, project, session_id, model, provider,
		input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Append one assistant message's spend. Best-effort: any failure (unwritable
 * path, locked DB, disk full) is logged at debug and dropped.
 */
export function recordLedgerEntry(entry: LedgerEntry): void {
	try {
		const input = tokenCount(entry.inputTokens);
		const output = tokenCount(entry.outputTokens);
		const cacheRead = tokenCount(entry.cacheReadTokens);
		const cacheWrite = tokenCount(entry.cacheWriteTokens);
		const cost = usd(entry.costUsd);
		// Free, empty turns (aborted before any tokens flowed) carry no signal.
		if (cost === 0 && input + output + cacheRead + cacheWrite === 0) return;
		const db = openDb();
		if (!db) return;
		const recordedAt = Number.isFinite(entry.recordedAt) ? Math.round(entry.recordedAt) : Date.now();
		db.query<void, (string | number | null)[]>(INSERT_SQL).run(
			recordedAt,
			entry.project,
			entry.sessionId ?? null,
			entry.model,
			entry.provider,
			input,
			output,
			cacheRead,
			cacheWrite,
			cost,
		);
	} catch (err) {
		logger.debug("usage ledger: append failed", { err: String(err) });
	}
}

/** Build the shared `WHERE` fragment plus its positional binds. */
function buildFilter(options: { project?: string; since?: number } | undefined): {
	where: string;
	binds: (string | number)[];
} {
	const clauses: string[] = [];
	const binds: (string | number)[] = [];
	if (options?.project !== undefined) {
		clauses.push("project = ?");
		binds.push(options.project);
	}
	if (options?.since !== undefined && Number.isFinite(options.since)) {
		clauses.push("recorded_at >= ?");
		binds.push(options.since);
	}
	return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", binds };
}

/**
 * Totals grouped by project, most expensive first. `project` narrows to one
 * project; `since` is an inclusive epoch-ms lower bound on `recordedAt`.
 */
export function queryProjectTotals(options?: { project?: string; since?: number }): ProjectTotals[] {
	try {
		const db = openDb();
		if (!db) return [];
		const { where, binds } = buildFilter(options);
		const rows = db
			.query<ProjectRow, (string | number)[]>(`
				SELECT
					project,
					SUM(cost_usd)           AS cost_usd,
					SUM(input_tokens)       AS input_tokens,
					SUM(output_tokens)      AS output_tokens,
					SUM(cache_read_tokens)  AS cache_read_tokens,
					SUM(cache_write_tokens) AS cache_write_tokens,
					COUNT(DISTINCT session_id) AS sessions,
					MIN(recorded_at)        AS first_recorded_at,
					MAX(recorded_at)        AS last_recorded_at
				FROM usage_ledger
				${where}
				GROUP BY project
				ORDER BY cost_usd DESC, project ASC
			`)
			.all(...binds);
		return rows.map(row => {
			const inputTokens = row.input_tokens ?? 0;
			const outputTokens = row.output_tokens ?? 0;
			const cacheReadTokens = row.cache_read_tokens ?? 0;
			const cacheWriteTokens = row.cache_write_tokens ?? 0;
			return {
				project: row.project,
				costUsd: row.cost_usd ?? 0,
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheWriteTokens,
				totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
				sessions: row.sessions ?? 0,
				firstRecordedAt: row.first_recorded_at ?? 0,
				lastRecordedAt: row.last_recorded_at ?? 0,
			};
		});
	} catch (err) {
		logger.debug("usage ledger: project totals query failed", { err: String(err) });
		return [];
	}
}

/** Totals grouped by model/provider, most expensive first. */
export function queryModelTotals(options?: { project?: string; since?: number }): ModelTotals[] {
	try {
		const db = openDb();
		if (!db) return [];
		const { where, binds } = buildFilter(options);
		const rows = db
			.query<ModelRow, (string | number)[]>(`
				SELECT
					model,
					provider,
					SUM(cost_usd) AS cost_usd,
					SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens,
					COUNT(*)      AS requests
				FROM usage_ledger
				${where}
				GROUP BY model, provider
				ORDER BY cost_usd DESC, model ASC
			`)
			.all(...binds);
		return rows.map(row => ({
			model: row.model,
			provider: row.provider,
			costUsd: row.cost_usd ?? 0,
			totalTokens: row.total_tokens ?? 0,
			requests: row.requests ?? 0,
		}));
	} catch (err) {
		logger.debug("usage ledger: model totals query failed", { err: String(err) });
		return [];
	}
}

/** Close the cached handle and re-arm lazy open. For tests and shutdown. */
export function closeLedger(): void {
	try {
		cachedDb?.close();
	} catch (err) {
		logger.debug("usage ledger: close failed", { err: String(err) });
	}
	cachedDb = null;
	openAttempted = false;
}
