/**
 * Physical schema for the native MemPalace vault.
 *
 * Migrations are an ordered, append-only list gated on `PRAGMA user_version`
 * and applied inside a single transaction, so a half-applied schema can never
 * be observed. Adding a table or a column means appending a new entry — never
 * editing an existing one, because a shipped migration has already run against
 * real databases and its text is now history rather than intent.
 *
 * Only `vault.ts` imports this module. Everything here is SQL and pragmas; no
 * row ever crosses this boundary.
 */

import type { Database } from "bun:sqlite";

/**
 * Position of `content` inside `drawers_fts`, whose columns are declared in the
 * order `(title, content)`.
 *
 * FTS5 addresses columns positionally in `snippet()` and `highlight()`, so this
 * is the only place that knows the index. Reordering the virtual table without
 * updating it would silently start snippeting the title instead of failing.
 */
export const FTS_CONTENT_COLUMN = 1;

interface Migration {
	readonly version: number;
	readonly up: string;
}

const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		up: `
CREATE TABLE IF NOT EXISTS wings (
	name TEXT PRIMARY KEY,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
	wing TEXT NOT NULL REFERENCES wings(name) ON DELETE CASCADE,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY(wing, name)
);

CREATE TABLE IF NOT EXISTS drawers (
	-- Surrogate integer key, deliberately distinct from the public id.
	--
	-- drawers_fts is an FTS5 external-content table, and those link to their
	-- content table by INTEGER rowid (content_rowid). The public id is a
	-- content-addressed hex string, so it cannot be that link; the index needs
	-- an integer to point at and seq is it.
	--
	-- AUTOINCREMENT rather than a bare INTEGER PRIMARY KEY is load-bearing.
	-- Without it SQLite assigns max(rowid)+1 and therefore recycles the rowid
	-- of a deleted row, which would hand a brand-new drawer whatever index
	-- entries the deleted one left behind. AUTOINCREMENT makes seq strictly
	-- monotonic for the life of the database, so an index entry can never be
	-- inherited by an unrelated drawer.
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	wing TEXT NOT NULL,
	room TEXT NOT NULL,
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	source TEXT,
	source_path TEXT,
	origin TEXT NOT NULL DEFAULT 'manual',
	added_by TEXT NOT NULL DEFAULT 'omp',
	-- JSON array of strings. SQLite has no array type, and the tag set is small
	-- enough that a side table would buy a join on every read for nothing.
	tags TEXT NOT NULL DEFAULT '[]',
	content_hash TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	-- The dedup key. Identical content in two different wings is two drawers.
	UNIQUE(wing, content_hash),
	FOREIGN KEY(wing, room) REFERENCES rooms(wing, name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_drawers_wing_room ON drawers(wing, room);
CREATE INDEX IF NOT EXISTS idx_drawers_source_path ON drawers(source_path);
CREATE INDEX IF NOT EXISTS idx_drawers_origin ON drawers(origin);

CREATE VIRTUAL TABLE IF NOT EXISTS drawers_fts USING fts5(
	title,
	content,
	content='drawers',
	content_rowid='seq'
);

-- External-content FTS5 keeps no copy of the text: it stores only the inverted
-- index and reads columns back through drawers. That makes these triggers
-- mandatory rather than a convenience — without them the index drifts from the
-- table it claims to describe, and the drift is silent until a query returns
-- rows that no longer say what the index thinks they say.
CREATE TRIGGER IF NOT EXISTS drawers_ai AFTER INSERT ON drawers BEGIN
	INSERT INTO drawers_fts(rowid, title, content) VALUES (new.seq, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS drawers_ad AFTER DELETE ON drawers BEGIN
	INSERT INTO drawers_fts(drawers_fts, rowid, title, content) VALUES ('delete', old.seq, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS drawers_au AFTER UPDATE ON drawers BEGIN
	INSERT INTO drawers_fts(drawers_fts, rowid, title, content) VALUES ('delete', old.seq, old.title, old.content);
	INSERT INTO drawers_fts(rowid, title, content) VALUES (new.seq, new.title, new.content);
END;

CREATE TABLE IF NOT EXISTS vectors (
	drawer_id TEXT NOT NULL REFERENCES drawers(id) ON DELETE CASCADE,
	model TEXT NOT NULL,
	dim INTEGER NOT NULL,
	-- Exactly dim little-endian float32 samples. See encodeVector in vault.ts.
	vec BLOB NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY(drawer_id, model)
);

CREATE TABLE IF NOT EXISTS diary (
	id TEXT PRIMARY KEY,
	wing TEXT NOT NULL,
	content TEXT NOT NULL,
	tags TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diary_wing_created ON diary(wing, created_at);

-- The Smart Mining ledger. A (size, mtime_ms) match proves a file is unchanged,
-- so a re-mine skips it without ever opening it; content_hash settles the cases
-- where the stat pair moved but the bytes did not. This table is what turns a
-- re-mine of a large tree from minutes of hashing into a stat walk.
CREATE TABLE IF NOT EXISTS mined_files (
	path TEXT PRIMARY KEY,
	wing TEXT NOT NULL,
	size INTEGER NOT NULL,
	mtime_ms REAL NOT NULL,
	content_hash TEXT NOT NULL,
	mined_at TEXT NOT NULL,
	drawer_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mined_files_wing ON mined_files(wing);
`,
	},
];

/** Highest migration version this build knows how to produce. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);

/**
 * Connection-level settings. Must run before {@link migrate}, because two of
 * the three cannot take effect inside a transaction.
 */
export function applyPragmas(db: Database): void {
	// First, and before any statement that can take a lock: a busy handler
	// installed later would leave the intervening statements to fail outright
	// on SQLITE_BUSY instead of waiting.
	db.run("PRAGMA busy_timeout = 5000");
	// Lets a reader (a search during a mine) proceed against a live writer.
	// A no-op — not an error — for :memory:, which has no journal to switch.
	db.run("PRAGMA journal_mode = WAL");
	// Off by default in SQLite, which would make every ON DELETE CASCADE above
	// inert: a deleted drawer would strand its vector rows forever.
	db.run("PRAGMA foreign_keys = ON");
}

function readUserVersion(db: Database): number {
	const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
	const version = row?.user_version;
	return typeof version === "number" && Number.isFinite(version) ? version : 0;
}

/**
 * Apply every migration newer than the database's `user_version` and return the
 * version now on disk. A no-op when the schema is already current.
 */
export function migrate(db: Database): number {
	const from = readUserVersion(db);
	const pending = MIGRATIONS.filter(migration => migration.version > from);
	if (pending.length === 0) return from;
	db.transaction(() => {
		for (const migration of pending) {
			db.run(migration.up);
			// PRAGMA values cannot be bound; this one is an integer literal from
			// the table above, never user input.
			db.run(`PRAGMA user_version = ${migration.version}`);
		}
	})();
	return SCHEMA_VERSION;
}

/**
 * Re-derive `drawers_fts` from `drawers`.
 *
 * Use this, never the FTS5 `'delete-all'` command. `'delete-all'` empties the
 * index behind the triggers' back, so the next `DELETE FROM drawers` fires an
 * AFTER DELETE trigger that tries to remove an entry which is already gone and
 * takes the whole statement down with SQLITE_CORRUPT_VTAB. `'rebuild'` re-reads
 * the content table instead, and that is consistent with the index by
 * construction.
 */
export function rebuildFtsIndex(db: Database): void {
	db.run("INSERT INTO drawers_fts(drawers_fts) VALUES('rebuild')");
}
