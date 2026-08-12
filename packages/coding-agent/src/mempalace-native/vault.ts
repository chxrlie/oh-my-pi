/**
 * Storage layer for the native MemPalace vault: schema access, content-hash
 * dedup, FTS5 lexical matching, vector blob persistence, and the Smart Mining
 * ledger. Synchronous throughout, because `bun:sqlite` is — keeping promises
 * out of storage leaves the serving and ingest layers as the only places that
 * can await, which is what makes their concurrency legible.
 *
 * This module never embeds, never walks the filesystem, and never reaches for
 * the network. It stores vectors and compares them; producing one is
 * `search.ts`'s job.
 *
 * Failure policy: every method catches its own errors, logs at debug, and
 * returns a safe empty value. A misconfigured memory store must degrade a turn,
 * never break it. Two deliberate exceptions:
 *
 *   - {@link openVault} propagates. A database that cannot be opened has no
 *     usable vault to hand back, and silently substituting an in-memory one
 *     would turn a configuration mistake into invisible data loss. Callers wrap
 *     the open, not the reads.
 *   - {@link Vault.addDrawer} propagates a genuinely unrecoverable sqlite
 *     failure, so a single write can be retried by the caller that knows what
 *     it was writing. The batched `addDrawers` does not: it rolls back and
 *     returns `[]`.
 */

import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { applyPragmas, FTS_CONTENT_COLUMN, migrate, rebuildFtsIndex } from "./schema";
import type {
	DiaryEntry,
	DiaryReadOptions,
	DiaryWriteInput,
	Drawer,
	DrawerFilter,
	DrawerInput,
	DrawerOrigin,
	DrawerPatch,
	DrawerWriteResult,
	LexicalHit,
	LexicalSearchOptions,
	MinedFileRecord,
	OpenVault,
	PendingVectorRow,
	Room,
	Vault,
	VaultOptions,
	VaultStats,
	VectorHit,
	VectorSearchOptions,
	Wing,
	WingNameFor,
} from "./types";

const MEMORY_PATH = ":memory:";

const DEFAULT_WING = "workspace";
const DEFAULT_ROOM = "notes";
const DEFAULT_TITLE = "untitled";
const DEFAULT_ORIGIN: DrawerOrigin = "manual";
const DEFAULT_ADDED_BY = "omp";

const DEFAULT_DRAWER_LIMIT = 50;
const MAX_DRAWER_LIMIT = 500;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
const DEFAULT_DIARY_LIMIT = 50;
const MAX_DIARY_LIMIT = 500;

/** Longest wing or room name kept; anything past this is a caller bug, not a name. */
const MAX_NAME_LENGTH = 200;
/** Cap on the text handed to an embedder per drawer. */
const PENDING_TEXT_LIMIT = 4000;
/** Ceiling on the phrases in one MATCH expression, so a pasted essay stays a query. */
const MAX_MATCH_PHRASES = 64;
/** Snippet width, in tokens, requested from FTS5. */
const SNIPPET_TOKENS = 24;

const EMPTY_VECTOR = new Float32Array(0);

const DRAWER_COLUMNS =
	"id, wing, room, title, content, source, source_path, origin, added_by, tags, content_hash, created_at, updated_at";

interface DrawerRow {
	id: string;
	wing: string;
	room: string;
	title: string;
	content: string;
	source: string | null;
	source_path: string | null;
	origin: string;
	added_by: string;
	tags: string;
	content_hash: string;
	created_at: string;
	updated_at: string;
}

interface WingRow {
	name: string;
	room_count: number;
	drawer_count: number;
	updated_at: string;
}

interface RoomRow {
	wing: string;
	name: string;
	drawer_count: number;
	updated_at: string;
}

interface DiaryRow {
	id: string;
	wing: string;
	content: string;
	tags: string;
	created_at: string;
}

interface MinedFileRow {
	path: string;
	wing: string;
	size: number;
	mtime_ms: number;
	content_hash: string;
	mined_at: string;
	drawer_count: number;
}

interface LexicalRow {
	id: string;
	score: number;
	snip: string | null;
}

interface VectorRow {
	drawer_id: string;
	dim: number;
	vec: unknown;
}

interface StatsRow {
	wings: number;
	rooms: number;
	drawers: number;
	diary_entries: number;
	vectors: number;
	last_write_at: string | null;
}

type Stmt<Row> = Statement<Row, SQLQueryBindings[]>;

/* -------------------------------------------------------------------------- */
/* Naming                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a project directory into a wing name: the basename, lowercased,
 * every run of characters outside `[a-z0-9_]` folded to a single underscore,
 * and the edges trimmed. Falls back to `workspace` when nothing survives, which
 * covers `/`, `""`, and directories named entirely in punctuation.
 */
export const wingNameFor: WingNameFor = projectDir => {
	const base = typeof projectDir === "string" ? path.basename(projectDir) : "";
	const slug = base
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return slug || DEFAULT_WING;
};

/**
 * Canonicalize a wing or room label. Sanitizing rather than rejecting is the
 * point: these names arrive from models and directory walks, and a vault that
 * throws on a stray control character would take a turn down with it.
 *
 * Punctuation and case are preserved so a room named `src/tools` stays legible;
 * only control characters and whitespace runs are normalized.
 */
function canonicalName(raw: string | undefined, fallback: string): string {
	if (typeof raw !== "string") return fallback;
	const cleaned = raw
		.replace(/\p{C}+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return fallback;
	return cleaned.length > MAX_NAME_LENGTH ? cleaned.slice(0, MAX_NAME_LENGTH).trim() || fallback : cleaned;
}

/** Trimmed single-line title, or `""` when the caller supplied nothing usable. */
function normalizeTitle(raw: string | undefined): string {
	if (typeof raw !== "string") return "";
	return raw
		.replace(/\p{C}+/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_NAME_LENGTH)
		.trim();
}

/* -------------------------------------------------------------------------- */
/* Identity and hashing                                                       */
/* -------------------------------------------------------------------------- */

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The dedup key: SHA-256 over content with CRLF folded to LF and trailing
 * whitespace dropped, so the same note filed from a Windows editor and a Unix
 * one is the same note.
 */
function hashContent(content: string): string {
	const normalized = (typeof content === "string" ? content : "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
	return sha256Hex(normalized);
}

/**
 * Drawer ids are content-addressed and therefore stable: re-filing identical
 * content into the same wing recomputes the id it already had, which is what
 * lets the miner be re-run without inventing duplicates. The wing is part of
 * the preimage so the same content in two wings gets two distinct drawers,
 * separated by a NUL that no wing name can contain.
 */
function drawerIdFor(wing: string, contentHash: string): string {
	return `drw_${sha256Hex(`${wing}\u0000${contentHash}`).slice(0, 16)}`;
}

/** Diary ids fold in the timestamp, since two notes may legitimately repeat. */
function diaryIdFor(wing: string, content: string, createdAt: string): string {
	return `dia_${sha256Hex(`${wing}${content}${createdAt}`).slice(0, 16)}`;
}

/* -------------------------------------------------------------------------- */
/* Row conversion                                                             */
/* -------------------------------------------------------------------------- */

function isOrigin(value: string): value is DrawerOrigin {
	return value === "manual" || value === "mined" || value === "convo" || value === "diary";
}

function parseTags(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((tag): tag is string => typeof tag === "string");
	} catch {
		return [];
	}
}

/** Trim, drop blanks, and de-duplicate while preserving the caller's order. */
function normalizeTags(tags: readonly string[] | undefined): string[] {
	if (!Array.isArray(tags)) return [];
	const unique = new Set<string>();
	for (const tag of tags) {
		if (typeof tag !== "string") continue;
		const trimmed = tag.trim();
		if (trimmed) unique.add(trimmed);
	}
	return [...unique];
}

function toDrawer(row: DrawerRow): Drawer {
	const drawer: Drawer = {
		id: row.id,
		wing: row.wing,
		room: row.room,
		title: row.title,
		content: row.content,
		origin: isOrigin(row.origin) ? row.origin : DEFAULT_ORIGIN,
		addedBy: row.added_by,
		tags: parseTags(row.tags),
		contentHash: row.content_hash,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
	if (row.source !== null) drawer.source = row.source;
	if (row.source_path !== null) drawer.sourcePath = row.source_path;
	return drawer;
}

/* -------------------------------------------------------------------------- */
/* Query shaping                                                              */
/* -------------------------------------------------------------------------- */

function normalizeLimit(value: number | undefined, fallback: number, cap: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	const truncated = Math.trunc(value);
	if (truncated <= 0) return 0;
	return Math.min(truncated, cap);
}

/**
 * Turn arbitrary prose into an FTS5 MATCH expression that cannot be malformed.
 *
 * Two steps, and both are load-bearing. First the characters that give FTS5 its
 * syntax are stripped from each token: a stray `"` is an unterminated string, a
 * `(` is a parse error, and a leading `-` is column-exclusion syntax that fails
 * with "no such column". Then each survivor is wrapped in double quotes, which
 * demotes it to a literal phrase — without that, a token that happens to spell
 * AND, OR, NOT or NEAR would be parsed as the operator it resembles. Stripping
 * before quoting is what makes the quoting airtight: no token can still hold a
 * quote of its own to break out with.
 *
 * A token must keep a letter or a digit to survive, because the unicode61
 * tokenizer yields no terms for pure punctuation and an empty phrase is dead
 * weight in the expression.
 *
 * Returns `""` when nothing survives; callers read that as "no results".
 */
function toMatchExpression(query: string): string {
	if (typeof query !== "string") return "";
	const phrases: string[] = [];
	const seen = new Set<string>();
	for (const rawToken of query.split(/\s+/)) {
		const token = rawToken.replace(/["*:^()]/g, "").replace(/^-+/, "");
		if (!token || !/[\p{L}\p{N}]/u.test(token)) continue;
		const key = token.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		phrases.push(`"${token}"`);
		if (phrases.length >= MAX_MATCH_PHRASES) break;
	}
	return phrases.join(" OR ");
}

/* -------------------------------------------------------------------------- */
/* Vector codec                                                               */
/* -------------------------------------------------------------------------- */

/** Native byte order, resolved once. Every stored blob is little-endian. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function toFloat32(values: Float32Array | readonly number[]): Float32Array {
	if (values instanceof Float32Array) return values;
	if (!Array.isArray(values)) return EMPTY_VECTOR;
	return Float32Array.from(values, value => (typeof value === "number" && Number.isFinite(value) ? value : 0));
}

function encodeVector(vector: Float32Array): Uint8Array {
	if (LITTLE_ENDIAN) return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
	const bytes = new Uint8Array(vector.length * 4);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < vector.length; i++) view.setFloat32(i * 4, vector[i], true);
	return bytes;
}

function decodeVector(blob: Uint8Array): Float32Array {
	const count = blob.byteLength >>> 2;
	if (count === 0) return EMPTY_VECTOR;
	if (LITTLE_ENDIAN) {
		// A Float32Array view requires 4-byte alignment against its underlying
		// buffer. sqlite hands back offset-0 blobs today, but a misaligned one
		// would throw rather than misread, so copy into a fresh buffer instead.
		if ((blob.byteOffset & 3) === 0) return new Float32Array(blob.buffer, blob.byteOffset, count);
		const aligned = blob.slice(0, count * 4);
		return new Float32Array(aligned.buffer, aligned.byteOffset, count);
	}
	const decoded = new Float32Array(count);
	const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	for (let i = 0; i < count; i++) decoded[i] = view.getFloat32(i * 4, true);
	return decoded;
}

function magnitude(vector: Float32Array): number {
	let total = 0;
	for (let i = 0; i < vector.length; i++) total += vector[i] * vector[i];
	return Math.sqrt(total);
}

/** Cosine similarity, or `NaN` for a zero-magnitude candidate (undefined angle). */
function cosine(query: Float32Array, queryMagnitude: number, candidate: Float32Array): number {
	let dot = 0;
	let candidateSquares = 0;
	for (let i = 0; i < query.length; i++) {
		const left = query[i];
		const right = candidate[i];
		dot += left * right;
		candidateSquares += right * right;
	}
	if (candidateSquares === 0) return Number.NaN;
	return dot / (queryMagnitude * Math.sqrt(candidateSquares));
}

/* -------------------------------------------------------------------------- */
/* Vault                                                                      */
/* -------------------------------------------------------------------------- */

class SqliteVault implements Vault {
	readonly path: string;

	#db: Database;
	#now: () => number;
	#closed = false;

	/** Everything prepared, for finalization on close. */
	#statements: Array<{ finalize(): void }> = [];
	/** Memo for the filter-shaped queries, keyed by their SQL text. */
	#shaped = new Map<string, Stmt<unknown>>();

	#upsertWing: Stmt<never>;
	#upsertRoom: Stmt<never>;
	#selectByHash: Stmt<DrawerRow>;
	#insertDrawer: Stmt<never>;
	#refreshDrawer: Stmt<never>;
	#selectDrawerById: Stmt<DrawerRow>;
	#selectDrawersByIds: Stmt<DrawerRow>;
	#deleteDrawerById: Stmt<{ id: string }>;
	#deleteDrawersBySourcePath: Stmt<{ id: string }>;
	#upsertVector: Stmt<never>;
	#selectPendingVectors: Stmt<PendingVectorRow>;
	#upsertMinedFile: Stmt<never>;
	#deleteMinedFile: Stmt<never>;
	#insertDiary: Stmt<never>;
	#selectStats: Stmt<StatsRow>;

	constructor(options: VaultOptions) {
		this.path = options.path;
		this.#now = typeof options.now === "function" ? options.now : Date.now;

		if (options.path !== MEMORY_PATH && (options.createDirs ?? true)) {
			try {
				fs.mkdirSync(path.dirname(options.path), { recursive: true });
			} catch (error) {
				// Losing the race with a concurrent mkdir is fine; a genuine
				// permission failure surfaces from the open below with a far more
				// specific message than anything worth throwing here.
				logger.debug("mempalace-native vault mkdir failed", { path: options.path, error: String(error) });
			}
		}

		this.#db = new Database(options.path);
		applyPragmas(this.#db);
		migrate(this.#db);

		this.#upsertWing = this.#prepare(
			`INSERT INTO wings (name, created_at, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at`,
		);
		this.#upsertRoom = this.#prepare(
			`INSERT INTO rooms (wing, name, created_at, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(wing, name) DO UPDATE SET updated_at = excluded.updated_at`,
		);
		this.#selectByHash = this.#prepare(`SELECT ${DRAWER_COLUMNS} FROM drawers WHERE wing = ? AND content_hash = ?`);
		this.#insertDrawer = this.#prepare(
			`INSERT INTO drawers
			 (id, wing, room, title, content, source, source_path, origin, added_by, tags, content_hash, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.#refreshDrawer = this.#prepare(
			"UPDATE drawers SET title = ?, room = ?, tags = ?, source = ?, updated_at = ? WHERE id = ?",
		);
		this.#selectDrawerById = this.#prepare(`SELECT ${DRAWER_COLUMNS} FROM drawers WHERE id = ?`);
		// json_each keeps this a single prepared statement for any id count; an
		// IN (?, ?, …) list would need a new statement per batch size.
		this.#selectDrawersByIds = this.#prepare(
			`SELECT ${DRAWER_COLUMNS} FROM drawers WHERE id IN (SELECT value FROM json_each(?))`,
		);
		// RETURNING, not run().changes: the FTS triggers inflate the change
		// counter, so it reports the index writes alongside the row deletes.
		this.#deleteDrawerById = this.#prepare("DELETE FROM drawers WHERE id = ? RETURNING id");
		this.#deleteDrawersBySourcePath = this.#prepare("DELETE FROM drawers WHERE source_path = ? RETURNING id");
		this.#upsertVector = this.#prepare(
			`INSERT INTO vectors (drawer_id, model, dim, vec, created_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(drawer_id, model) DO UPDATE SET
			   dim = excluded.dim, vec = excluded.vec, created_at = excluded.created_at`,
		);
		this.#selectPendingVectors = this.#prepare(
			`SELECT d.id AS drawerId, substr(d.title || char(10) || d.content, 1, ${PENDING_TEXT_LIMIT}) AS text
			 FROM drawers d
			 WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.drawer_id = d.id AND v.model = ?)
			 ORDER BY d.created_at ASC, d.seq ASC
			 LIMIT ?`,
		);
		this.#upsertMinedFile = this.#prepare(
			`INSERT INTO mined_files (path, wing, size, mtime_ms, content_hash, mined_at, drawer_count)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(path) DO UPDATE SET
			   wing = excluded.wing, size = excluded.size, mtime_ms = excluded.mtime_ms,
			   content_hash = excluded.content_hash, mined_at = excluded.mined_at,
			   drawer_count = excluded.drawer_count`,
		);
		this.#deleteMinedFile = this.#prepare("DELETE FROM mined_files WHERE path = ?");
		this.#insertDiary = this.#prepare(
			`INSERT INTO diary (id, wing, content, tags, created_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO NOTHING`,
		);
		this.#selectStats = this.#prepare(
			`SELECT
			   (SELECT COUNT(*) FROM wings) AS wings,
			   (SELECT COUNT(*) FROM rooms) AS rooms,
			   (SELECT COUNT(*) FROM drawers) AS drawers,
			   (SELECT COUNT(*) FROM diary) AS diary_entries,
			   (SELECT COUNT(*) FROM vectors) AS vectors,
			   (SELECT MAX(ts) FROM (
			      SELECT MAX(updated_at) AS ts FROM drawers
			      UNION ALL
			      SELECT MAX(created_at) FROM diary
			   )) AS last_write_at`,
		);
	}

	/* ---------------------------------------------------------------------- */
	/* Internals                                                              */
	/* ---------------------------------------------------------------------- */

	// db.prepare rather than db.query: query() memoizes statements inside the
	// Database, and close() finalizes everything this list holds — finalizing a
	// statement the internal cache still hands out would be a use-after-free
	// waiting for the next caller with the same SQL text.
	#prepare<Row>(sql: string): Stmt<Row> {
		const prepared = this.#db.prepare<Row, SQLQueryBindings[]>(sql);
		this.#statements.push(prepared);
		return prepared;
	}

	/**
	 * Prepare-once memo for queries whose WHERE clause depends on which filters
	 * a caller supplied. The number of distinct shapes is small and bounded by
	 * the filter interfaces, so this converges to a fixed statement set after
	 * the first few calls rather than re-preparing per query.
	 */
	#shapedStmt<Row>(sql: string): Stmt<Row> {
		const cached = this.#shaped.get(sql);
		if (cached) {
			// The SQL text determines the row shape, and the cache is keyed by
			// exactly that text — the invariant TypeScript cannot express for a
			// heterogeneous statement cache.
			const typed = cached as Stmt<Row>;
			return typed;
		}
		const prepared = this.#prepare<Row>(sql);
		this.#shaped.set(sql, prepared);
		return prepared;
	}

	#iso(): string {
		const ms = this.#now();
		return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
	}

	/** Create the wing and room rows and return the canonical room name. */
	#ensureRoomInternal(wing: string, room: string, timestamp: string): string {
		this.#upsertWing.run(wing, timestamp, timestamp);
		this.#upsertRoom.run(wing, room, timestamp, timestamp);
		return room;
	}

	/* ---------------------------------------------------------------------- */
	/* Wings and rooms                                                        */
	/* ---------------------------------------------------------------------- */

	listWings(): Wing[] {
		if (this.#closed) return [];
		try {
			const rows = this.#shapedStmt<WingRow>(
				`SELECT w.name AS name,
				        (SELECT COUNT(*) FROM rooms r WHERE r.wing = w.name) AS room_count,
				        (SELECT COUNT(*) FROM drawers d WHERE d.wing = w.name) AS drawer_count,
				        w.updated_at AS updated_at
				 FROM wings w ORDER BY w.name ASC`,
			).all();
			return rows.map(row => ({
				name: row.name,
				roomCount: row.room_count,
				drawerCount: row.drawer_count,
				updatedAt: row.updated_at,
			}));
		} catch (error) {
			logger.debug("mempalace-native listWings failed", { error: String(error) });
			return [];
		}
	}

	listRooms(wing?: string): Room[] {
		if (this.#closed) return [];
		try {
			const filtered = wing !== undefined;
			const rows = this.#shapedStmt<RoomRow>(
				`SELECT r.wing AS wing, r.name AS name,
				        (SELECT COUNT(*) FROM drawers d WHERE d.wing = r.wing AND d.room = r.name) AS drawer_count,
				        r.updated_at AS updated_at
				 FROM rooms r${filtered ? " WHERE r.wing = ?" : ""}
				 ORDER BY r.wing ASC, r.name ASC`,
			).all(...(filtered ? [canonicalName(wing, DEFAULT_WING)] : []));
			return rows.map(row => ({
				wing: row.wing,
				name: row.name,
				drawerCount: row.drawer_count,
				updatedAt: row.updated_at,
			}));
		} catch (error) {
			logger.debug("mempalace-native listRooms failed", { error: String(error) });
			return [];
		}
	}

	ensureRoom(wing: string, room: string): string {
		const canonicalRoom = canonicalName(room, DEFAULT_ROOM);
		if (this.#closed) return canonicalRoom;
		try {
			return this.#ensureRoomInternal(canonicalName(wing, DEFAULT_WING), canonicalRoom, this.#iso());
		} catch (error) {
			logger.debug("mempalace-native ensureRoom failed", { wing, room, error: String(error) });
			return canonicalRoom;
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Drawers                                                                */
	/* ---------------------------------------------------------------------- */

	/**
	 * File a drawer, deduplicating on `(wing, contentHash)`.
	 *
	 * Unlike every other method here this one propagates: a caller writing a
	 * specific drawer can retry it, and swallowing the failure would report a
	 * write that never happened. `sourcePath`, `origin` and `addedBy` are sticky
	 * on a dedup hit — first writer wins — so re-filing existing content through
	 * a different path cannot silently reattribute it.
	 */
	addDrawer(input: DrawerInput): DrawerWriteResult {
		const wing = canonicalName(input.wing, DEFAULT_WING);
		const timestamp = this.#iso();
		const room = this.#ensureRoomInternal(wing, canonicalName(input.room, DEFAULT_ROOM), timestamp);
		const content = typeof input.content === "string" ? input.content : "";
		const contentHash = hashContent(content);
		const id = drawerIdFor(wing, contentHash);
		const title = normalizeTitle(input.title);
		const source = typeof input.source === "string" ? input.source : null;

		const existing = this.#selectByHash.get(wing, contentHash);
		if (existing) {
			const nextTitle = title || existing.title;
			const nextTags = input.tags === undefined ? existing.tags : JSON.stringify(normalizeTags(input.tags));
			const nextSource = source ?? existing.source;
			const unchanged =
				nextTitle === existing.title &&
				room === existing.room &&
				nextTags === existing.tags &&
				nextSource === existing.source;
			if (unchanged) return { id: existing.id, created: false, updated: false };
			this.#refreshDrawer.run(nextTitle, room, nextTags, nextSource, timestamp, existing.id);
			return { id: existing.id, created: false, updated: true };
		}

		this.#insertDrawer.run(
			id,
			wing,
			room,
			title || DEFAULT_TITLE,
			content,
			source,
			typeof input.sourcePath === "string" ? input.sourcePath : null,
			input.origin ?? DEFAULT_ORIGIN,
			typeof input.addedBy === "string" && input.addedBy ? input.addedBy : DEFAULT_ADDED_BY,
			JSON.stringify(normalizeTags(input.tags)),
			contentHash,
			timestamp,
			timestamp,
		);
		return { id, created: true, updated: false };
	}

	/**
	 * Batched {@link addDrawer} in one transaction.
	 *
	 * Catches, unlike the singular form: a bulk caller cannot act on a partial
	 * outcome, and the transaction guarantees there is no partial outcome to act
	 * on. An empty array therefore means "nothing was written, safe to retry" —
	 * never "all of these already existed".
	 */
	addDrawers(inputs: readonly DrawerInput[]): DrawerWriteResult[] {
		if (this.#closed || !Array.isArray(inputs) || inputs.length === 0) return [];
		try {
			return this.#db.transaction(() => inputs.map(input => this.addDrawer(input)))();
		} catch (error) {
			logger.debug("mempalace-native addDrawers rolled back", { count: inputs.length, error: String(error) });
			return [];
		}
	}

	getDrawer(id: string): Drawer | undefined {
		if (this.#closed) return undefined;
		try {
			const row = this.#selectDrawerById.get(id);
			return row ? toDrawer(row) : undefined;
		} catch (error) {
			logger.debug("mempalace-native getDrawer failed", { id, error: String(error) });
			return undefined;
		}
	}

	/** Survivors in the caller's id order; missing ids are skipped, not held. */
	getDrawers(ids: readonly string[]): Drawer[] {
		if (this.#closed || !Array.isArray(ids) || ids.length === 0) return [];
		try {
			const wanted = ids.filter(id => typeof id === "string");
			if (wanted.length === 0) return [];
			const found = new Map<string, Drawer>();
			for (const row of this.#selectDrawersByIds.all(JSON.stringify(wanted))) {
				found.set(row.id, toDrawer(row));
			}
			const ordered: Drawer[] = [];
			for (const id of wanted) {
				const drawer = found.get(id);
				if (drawer) ordered.push(drawer);
			}
			return ordered;
		} catch (error) {
			logger.debug("mempalace-native getDrawers failed", { count: ids.length, error: String(error) });
			return [];
		}
	}

	/**
	 * Patch a drawer in place. The id is deliberately *not* re-derived when the
	 * content changes: it is a stable handle that `vectors` references and that
	 * callers hold, so it outlives the hash it was minted from. `content_hash`
	 * is refreshed so dedup keeps working from the new content.
	 */
	updateDrawer(id: string, patch: DrawerPatch): boolean {
		if (this.#closed) return false;
		try {
			const existing = this.#selectDrawerById.get(id);
			if (!existing) return false;

			const assignments: string[] = [];
			const bindings: SQLQueryBindings[] = [];
			if (typeof patch.title === "string") {
				assignments.push("title = ?");
				bindings.push(normalizeTitle(patch.title) || existing.title);
			}
			if (typeof patch.content === "string") {
				assignments.push("content = ?", "content_hash = ?");
				bindings.push(patch.content, hashContent(patch.content));
			}
			if (typeof patch.room === "string") {
				const room = this.#ensureRoomInternal(existing.wing, canonicalName(patch.room, DEFAULT_ROOM), this.#iso());
				assignments.push("room = ?");
				bindings.push(room);
			}
			if (patch.tags !== undefined) {
				assignments.push("tags = ?");
				bindings.push(JSON.stringify(normalizeTags(patch.tags)));
			}
			if (typeof patch.source === "string") {
				assignments.push("source = ?");
				bindings.push(patch.source);
			}
			if (assignments.length === 0) return true;

			assignments.push("updated_at = ?");
			bindings.push(this.#iso(), id);
			const updated = this.#shapedStmt<{ id: string }>(
				`UPDATE drawers SET ${assignments.join(", ")} WHERE id = ? RETURNING id`,
			).all(...bindings);
			return updated.length > 0;
		} catch (error) {
			// A content patch can collide with another drawer's hash in the same
			// wing; UNIQUE(wing, content_hash) rejects it and the drawer stands.
			logger.debug("mempalace-native updateDrawer failed", { id, error: String(error) });
			return false;
		}
	}

	deleteDrawer(id: string): boolean {
		if (this.#closed) return false;
		try {
			return this.#deleteDrawerById.all(id).length > 0;
		} catch (error) {
			logger.debug("mempalace-native deleteDrawer failed", { id, error: String(error) });
			return false;
		}
	}

	deleteBySource(sourcePath: string): number {
		if (this.#closed) return 0;
		try {
			return this.#deleteDrawersBySourcePath.all(sourcePath).length;
		} catch (error) {
			logger.debug("mempalace-native deleteBySource failed", { sourcePath, error: String(error) });
			return 0;
		}
	}

	listDrawers(filter: DrawerFilter = {}): Drawer[] {
		if (this.#closed) return [];
		try {
			const clauses: string[] = [];
			const bindings: SQLQueryBindings[] = [];
			if (filter.wing !== undefined) {
				clauses.push("wing = ?");
				bindings.push(canonicalName(filter.wing, DEFAULT_WING));
			}
			if (filter.room !== undefined) {
				clauses.push("room = ?");
				bindings.push(canonicalName(filter.room, DEFAULT_ROOM));
			}
			if (filter.source !== undefined) {
				clauses.push("source = ?");
				bindings.push(filter.source);
			}
			if (filter.sourcePath !== undefined) {
				clauses.push("source_path = ?");
				bindings.push(filter.sourcePath);
			}
			if (filter.origin !== undefined) {
				clauses.push("origin = ?");
				bindings.push(filter.origin);
			}
			const offset = filter.offset;
			bindings.push(
				normalizeLimit(filter.limit, DEFAULT_DRAWER_LIMIT, MAX_DRAWER_LIMIT),
				offset === undefined || !Number.isFinite(offset) ? 0 : Math.max(0, Math.trunc(offset)),
			);
			const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
			const rows = this.#shapedStmt<DrawerRow>(
				`SELECT ${DRAWER_COLUMNS} FROM drawers${where} ORDER BY updated_at DESC, seq DESC LIMIT ? OFFSET ?`,
			).all(...bindings);
			return rows.map(toDrawer);
		} catch (error) {
			logger.debug("mempalace-native listDrawers failed", { error: String(error) });
			return [];
		}
	}

	knownSourcePaths(wing?: string): string[] {
		if (this.#closed) return [];
		try {
			const filtered = wing !== undefined;
			const rows = this.#shapedStmt<{ source_path: string }>(
				`SELECT DISTINCT source_path AS source_path FROM drawers
				 WHERE source_path IS NOT NULL${filtered ? " AND wing = ?" : ""}
				 ORDER BY source_path ASC`,
			).all(...(filtered ? [canonicalName(wing, DEFAULT_WING)] : []));
			return rows.map(row => row.source_path);
		} catch (error) {
			logger.debug("mempalace-native knownSourcePaths failed", { error: String(error) });
			return [];
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Smart Mining ledger                                                    */
	/* ---------------------------------------------------------------------- */

	/**
	 * The whole ledger for a wing in one query. Read once per mine and probed
	 * per candidate file, so it is a map in memory rather than a query per
	 * file — the difference between one statement and tens of thousands.
	 */
	getMinedFiles(wing?: string): Map<string, MinedFileRecord> {
		const ledger = new Map<string, MinedFileRecord>();
		if (this.#closed) return ledger;
		try {
			const filtered = wing !== undefined;
			const rows = this.#shapedStmt<MinedFileRow>(
				`SELECT path, wing, size, mtime_ms, content_hash, mined_at, drawer_count
				 FROM mined_files${filtered ? " WHERE wing = ?" : ""}`,
			).all(...(filtered ? [canonicalName(wing, DEFAULT_WING)] : []));
			for (const row of rows) {
				ledger.set(row.path, {
					path: row.path,
					wing: row.wing,
					size: row.size,
					mtimeMs: row.mtime_ms,
					contentHash: row.content_hash,
					minedAt: row.mined_at,
					drawerCount: row.drawer_count,
				});
			}
			return ledger;
		} catch (error) {
			logger.debug("mempalace-native getMinedFiles failed", { error: String(error) });
			return ledger;
		}
	}

	recordMinedFile(record: MinedFileRecord): void {
		if (this.#closed) return;
		try {
			this.#upsertMinedFile.run(
				record.path,
				canonicalName(record.wing, DEFAULT_WING),
				Math.trunc(record.size) || 0,
				Number.isFinite(record.mtimeMs) ? record.mtimeMs : 0,
				record.contentHash,
				record.minedAt,
				Math.trunc(record.drawerCount) || 0,
			);
		} catch (error) {
			logger.debug("mempalace-native recordMinedFile failed", { path: record.path, error: String(error) });
		}
	}

	forgetMinedFile(filePath: string): void {
		if (this.#closed) return;
		try {
			this.#deleteMinedFile.run(filePath);
		} catch (error) {
			logger.debug("mempalace-native forgetMinedFile failed", { path: filePath, error: String(error) });
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Search                                                                 */
	/* ---------------------------------------------------------------------- */

	searchLexical(query: string, options: LexicalSearchOptions = {}): LexicalHit[] {
		if (this.#closed) return [];
		const match = toMatchExpression(query);
		if (!match) return [];
		try {
			const clauses: string[] = [];
			const bindings: SQLQueryBindings[] = [match];
			if (options.wing !== undefined) {
				clauses.push("d.wing = ?");
				bindings.push(canonicalName(options.wing, DEFAULT_WING));
			}
			if (options.room !== undefined) {
				clauses.push("d.room = ?");
				bindings.push(canonicalName(options.room, DEFAULT_ROOM));
			}
			if (options.source !== undefined) {
				clauses.push("d.source = ?");
				bindings.push(options.source);
			}
			bindings.push(normalizeLimit(options.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT));
			const extra = clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
			// The snippet column index is a module constant, never user input.
			// bm25 is negative-is-better, so the sign flip makes the exported
			// score higher-is-better while the SQL sort stays ascending.
			const rows = this.#shapedStmt<LexicalRow>(
				`SELECT d.id AS id,
				        -bm25(drawers_fts) AS score,
				        snippet(drawers_fts, ${FTS_CONTENT_COLUMN}, '', '', '…', ${SNIPPET_TOKENS}) AS snip
				 FROM drawers_fts
				 JOIN drawers d ON d.seq = drawers_fts.rowid
				 WHERE drawers_fts MATCH ?${extra}
				 ORDER BY bm25(drawers_fts) ASC
				 LIMIT ?`,
			).all(...bindings);
			return rows.map(row => ({ drawerId: row.id, score: row.score, snippet: row.snip ?? "" }));
		} catch (error) {
			logger.debug("mempalace-native searchLexical failed", { error: String(error) });
			return [];
		}
	}

	putVector(drawerId: string, model: string, vector: Float32Array | readonly number[]): void {
		if (this.#closed) return;
		try {
			const values = toFloat32(vector);
			if (values.length === 0) return;
			this.#upsertVector.run(drawerId, model, values.length, encodeVector(values), this.#iso());
		} catch (error) {
			logger.debug("mempalace-native putVector failed", { drawerId, model, error: String(error) });
		}
	}

	pendingVectors(model: string, limit: number): PendingVectorRow[] {
		if (this.#closed) return [];
		const capped = normalizeLimit(limit, DEFAULT_DRAWER_LIMIT, Number.MAX_SAFE_INTEGER);
		if (capped === 0) return [];
		try {
			return this.#selectPendingVectors.all(model, capped);
		} catch (error) {
			logger.debug("mempalace-native pendingVectors failed", { model, error: String(error) });
			return [];
		}
	}

	/**
	 * Brute-force cosine scan over one model's vectors.
	 *
	 * Rows stream rather than materialize: a vault's worth of blobs held at once
	 * to sort them would cost far more than the scan itself. A stored vector
	 * whose `dim` disagrees with the query is skipped rather than thrown on, so
	 * swapping embedding models degrades the result set instead of breaking
	 * search until a re-embed finishes.
	 */
	searchVector(query: Float32Array | readonly number[], options: VectorSearchOptions): VectorHit[] {
		if (this.#closed) return [];
		try {
			const probe = toFloat32(query);
			const probeMagnitude = magnitude(probe);
			if (probe.length === 0 || probeMagnitude === 0) return [];

			const clauses: string[] = [];
			const bindings: SQLQueryBindings[] = [options.model];
			if (options.wing !== undefined) {
				clauses.push("d.wing = ?");
				bindings.push(canonicalName(options.wing, DEFAULT_WING));
			}
			if (options.room !== undefined) {
				clauses.push("d.room = ?");
				bindings.push(canonicalName(options.room, DEFAULT_ROOM));
			}
			const extra = clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
			const statement = this.#shapedStmt<VectorRow>(
				`SELECT v.drawer_id AS drawer_id, v.dim AS dim, v.vec AS vec
				 FROM vectors v JOIN drawers d ON d.id = v.drawer_id
				 WHERE v.model = ?${extra}`,
			);

			const hits: VectorHit[] = [];
			for (const row of statement.iterate(...bindings)) {
				if (row.dim !== probe.length || !(row.vec instanceof Uint8Array)) continue;
				const candidate = decodeVector(row.vec);
				if (candidate.length !== probe.length) continue;
				const score = cosine(probe, probeMagnitude, candidate);
				if (!Number.isFinite(score)) continue;
				hits.push({ drawerId: row.drawer_id, score });
			}
			hits.sort((left, right) => right.score - left.score);
			const limit = normalizeLimit(options.limit, DEFAULT_SEARCH_LIMIT, Number.MAX_SAFE_INTEGER);
			return hits.length > limit ? hits.slice(0, limit) : hits;
		} catch (error) {
			logger.debug("mempalace-native searchVector failed", { model: options.model, error: String(error) });
			return [];
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Diary                                                                  */
	/* ---------------------------------------------------------------------- */

	writeDiary(entry: DiaryWriteInput): DiaryEntry {
		const wing = canonicalName(entry.wing, DEFAULT_WING);
		const content = typeof entry.content === "string" ? entry.content : "";
		const createdAt = this.#iso();
		const tags = normalizeTags(entry.tags);
		const written: DiaryEntry = { id: diaryIdFor(wing, content, createdAt), wing, content, tags, createdAt };
		if (this.#closed) return written;
		try {
			// The diary has no FK to wings, but a wing holding only diary entries
			// should still appear in listWings, so stamp it here too.
			this.#upsertWing.run(wing, createdAt, createdAt);
			this.#insertDiary.run(written.id, wing, content, JSON.stringify(tags), createdAt);
		} catch (error) {
			// The signature cannot express failure, so the caller gets the entry
			// it asked for and the log records that it did not land.
			logger.debug("mempalace-native writeDiary failed", { wing, error: String(error) });
		}
		return written;
	}

	readDiary(options: DiaryReadOptions = {}): DiaryEntry[] {
		if (this.#closed) return [];
		try {
			const clauses: string[] = [];
			const bindings: SQLQueryBindings[] = [];
			if (options.wing !== undefined) {
				clauses.push("wing = ?");
				bindings.push(canonicalName(options.wing, DEFAULT_WING));
			}
			if (options.since !== undefined) {
				clauses.push("created_at >= ?");
				bindings.push(options.since);
			}
			bindings.push(normalizeLimit(options.limit, DEFAULT_DIARY_LIMIT, MAX_DIARY_LIMIT));
			const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
			const rows = this.#shapedStmt<DiaryRow>(
				`SELECT id, wing, content, tags, created_at FROM diary${where}
				 ORDER BY created_at DESC, id DESC LIMIT ?`,
			).all(...bindings);
			return rows.map(row => ({
				id: row.id,
				wing: row.wing,
				content: row.content,
				tags: parseTags(row.tags),
				createdAt: row.created_at,
			}));
		} catch (error) {
			logger.debug("mempalace-native readDiary failed", { error: String(error) });
			return [];
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Lifecycle                                                              */
	/* ---------------------------------------------------------------------- */

	stats(): VaultStats {
		const empty: VaultStats = { wings: 0, rooms: 0, drawers: 0, diaryEntries: 0, vectors: 0, dbBytes: 0 };
		if (this.#closed) return empty;
		try {
			const row = this.#selectStats.get();
			if (!row) return empty;
			const stats: VaultStats = {
				wings: row.wings,
				rooms: row.rooms,
				drawers: row.drawers,
				diaryEntries: row.diary_entries,
				vectors: row.vectors,
				dbBytes: this.#dbBytes(),
			};
			if (row.last_write_at !== null) stats.lastWriteAt = row.last_write_at;
			return stats;
		} catch (error) {
			logger.debug("mempalace-native stats failed", { error: String(error) });
			return empty;
		}
	}

	#dbBytes(): number {
		if (this.path === MEMORY_PATH) return 0;
		try {
			return fs.statSync(this.path).size;
		} catch {
			// Not yet flushed to disk, or gone. Either way it is not an error
			// worth surfacing from a stats call.
			return 0;
		}
	}

	wipe(): void {
		if (this.#closed) return;
		try {
			this.#db.transaction(() => {
				// Drawers first: the AFTER DELETE trigger drains drawers_fts row by
				// row, and the vector rows cascade off the drawer foreign key.
				this.#db.run("DELETE FROM drawers");
				this.#db.run("DELETE FROM vectors");
				this.#db.run("DELETE FROM diary");
				this.#db.run("DELETE FROM mined_files");
				this.#db.run("DELETE FROM rooms");
				this.#db.run("DELETE FROM wings");
				// Near-free against an empty content table, and it repairs any
				// drift the triggers may have left. Never 'delete-all' — see the
				// warning on rebuildFtsIndex.
				rebuildFtsIndex(this.#db);
			})();
			// sqlite_sequence is deliberately left alone: seq stays monotonic
			// across a wipe, so a post-wipe drawer can never land on a rowid the
			// index remembers.
		} catch (error) {
			logger.debug("mempalace-native wipe failed", { error: String(error) });
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			for (const statement of this.#statements) statement.finalize();
			this.#statements = [];
			this.#shaped.clear();
			this.#db.close();
		} catch (error) {
			logger.debug("mempalace-native close failed", { error: String(error) });
		}
	}
}

/**
 * Open (and migrate) a vault.
 *
 * Propagates when the database cannot be opened — see the failure policy at the
 * top of this module. Every method on the returned vault degrades instead.
 */
export const openVault: OpenVault = options => new SqliteVault(options);
