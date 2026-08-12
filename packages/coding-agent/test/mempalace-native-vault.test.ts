import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Vault } from "@oh-my-pi/pi-coding-agent/mempalace-native/types";
import { openVault, wingNameFor } from "@oh-my-pi/pi-coding-agent/mempalace-native/vault";

const vaults: Vault[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const vault of vaults.splice(0)) vault.close();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A `:memory:` vault on a clock that steps one second per read, so every write
 * gets a distinct, strictly increasing timestamp and ordering assertions are
 * deterministic rather than dependent on how fast the test runs.
 */
function makeVault(): Vault {
	let clock = Date.parse("2026-01-01T00:00:00.000Z");
	const vault = openVault({
		path: ":memory:",
		now: () => {
			clock += 1000;
			return clock;
		},
	});
	vaults.push(vault);
	return vault;
}

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mempalace-vault-"));
	tempDirs.push(dir);
	return dir;
}

describe("wingNameFor", () => {
	test("slugs a basename and falls back to workspace", () => {
		expect(wingNameFor("/home/charlie/Projects/Oh-My-Pi")).toBe("oh_my_pi");
		expect(wingNameFor("/tmp/my project 2")).toBe("my_project_2");
		expect(wingNameFor("/srv/keep_this")).toBe("keep_this");
		expect(wingNameFor("/var/lib/UPPER")).toBe("upper");
		// Sanitizes to empty: every character folds to an underscore, and the
		// underscores are then edge-trimmed away.
		expect(wingNameFor("/var/data/---")).toBe("workspace");
		expect(wingNameFor("/")).toBe("workspace");
		expect(wingNameFor("")).toBe("workspace");
	});
});

describe("vault drawers", () => {
	test("identical content in one wing files a single drawer", () => {
		const vault = makeVault();
		const first = vault.addDrawer({ wing: "alpha", room: "notes", title: "Note", content: "the same body" });
		const second = vault.addDrawer({ wing: "alpha", room: "notes", title: "Note", content: "the same body" });

		expect(first).toEqual({ id: first.id, created: true, updated: false });
		expect(second).toEqual({ id: first.id, created: false, updated: false });
		expect(vault.listDrawers({ wing: "alpha" })).toHaveLength(1);
	});

	test("the content hash ignores CRLF and trailing whitespace", () => {
		const vault = makeVault();
		const crlf = vault.addDrawer({ wing: "alpha", room: "notes", title: "N", content: "line one\r\nline two" });
		const lf = vault.addDrawer({ wing: "alpha", room: "notes", title: "N", content: "line one\nline two   \n\n" });

		expect(lf.id).toBe(crlf.id);
		expect(lf.created).toBe(false);
		expect(vault.stats().drawers).toBe(1);
	});

	test("a changed title, room, tag set or source refreshes the drawer in place", () => {
		const vault = makeVault();
		const created = vault.addDrawer({
			wing: "alpha",
			room: "notes",
			title: "Old",
			content: "shared body",
			source: "first-writer",
		});
		const refreshed = vault.addDrawer({
			wing: "alpha",
			room: "archive",
			title: "New",
			content: "shared body",
			source: "second-writer",
			tags: ["backoff", "mine"],
		});

		expect(refreshed).toEqual({ id: created.id, created: false, updated: true });

		const drawer = vault.getDrawer(created.id);
		if (!drawer) throw new Error("drawer vanished after refresh");
		expect(drawer.title).toBe("New");
		expect(drawer.room).toBe("archive");
		expect(drawer.tags).toEqual(["backoff", "mine"]);
		expect(drawer.source).toBe("second-writer");
		expect(drawer.updatedAt > drawer.createdAt).toBe(true);

		// Re-filing the now-current shape has nothing left to change.
		const again = vault.addDrawer({
			wing: "alpha",
			room: "archive",
			title: "New",
			content: "shared body",
			source: "second-writer",
			tags: ["backoff", "mine"],
		});
		expect(again).toEqual({ id: created.id, created: false, updated: false });
		expect(vault.stats().drawers).toBe(1);
	});

	test("the same content in two wings is two drawers", () => {
		const vault = makeVault();
		const alpha = vault.addDrawer({ wing: "alpha", room: "notes", title: "Shared", content: "identical body" });
		const beta = vault.addDrawer({ wing: "beta", room: "notes", title: "Shared", content: "identical body" });

		expect(beta.created).toBe(true);
		expect(beta.id).not.toBe(alpha.id);
		expect(vault.stats().drawers).toBe(2);
		expect(vault.listDrawers({ wing: "beta" }).map(drawer => drawer.id)).toEqual([beta.id]);
	});

	test("addDrawers returns one result per input, in order", () => {
		const vault = makeVault();
		const results = vault.addDrawers([
			{ wing: "alpha", room: "notes", title: "One", content: "body one" },
			{ wing: "alpha", room: "notes", title: "Two", content: "body two" },
			{ wing: "alpha", room: "notes", title: "One again", content: "body one" },
		]);

		expect(results).toHaveLength(3);
		expect(results.map(result => result.created)).toEqual([true, true, false]);
		expect(results[2].id).toBe(results[0].id);
		expect(vault.stats().drawers).toBe(2);
		expect(vault.addDrawers([])).toEqual([]);
	});

	test("getDrawers returns survivors in the caller's id order", () => {
		const vault = makeVault();
		const one = vault.addDrawer({ wing: "alpha", room: "notes", title: "One", content: "body one" });
		const two = vault.addDrawer({ wing: "alpha", room: "notes", title: "Two", content: "body two" });

		const found = vault.getDrawers([two.id, "drw_missing", one.id]);
		expect(found.map(drawer => drawer.id)).toEqual([two.id, one.id]);
		expect(vault.getDrawers([])).toEqual([]);
	});

	test("updateDrawer rewrites the row and reindexes it", () => {
		const vault = makeVault();
		const drawer = vault.addDrawer({ wing: "alpha", room: "notes", title: "First", content: "aardvark sighting" });
		expect(vault.searchLexical("aardvark").map(hit => hit.drawerId)).toEqual([drawer.id]);

		expect(vault.updateDrawer(drawer.id, { title: "Second", content: "buffalo sighting" })).toBe(true);

		const updated = vault.getDrawer(drawer.id);
		if (!updated) throw new Error("drawer vanished after update");
		expect(updated.title).toBe("Second");
		expect(updated.content).toBe("buffalo sighting");
		// The id is a stable handle, so it survives a content change even though
		// it was originally minted from the old content hash.
		expect(updated.id).toBe(drawer.id);

		// The AFTER UPDATE trigger has to delete the old index entry and add the
		// new one; a half-done trigger leaves the stale term matchable.
		expect(vault.searchLexical("aardvark")).toEqual([]);
		expect(vault.searchLexical("buffalo").map(hit => hit.drawerId)).toEqual([drawer.id]);

		expect(vault.updateDrawer("drw_missing", { title: "nope" })).toBe(false);
	});

	test("deleteBySource removes exactly the drawers from one path", () => {
		const vault = makeVault();
		for (const body of ["chunk one", "chunk two", "chunk three"]) {
			vault.addDrawer({ wing: "alpha", room: "notes", title: body, content: body, sourcePath: "/repo/a.md" });
		}
		vault.addDrawer({
			wing: "alpha",
			room: "notes",
			title: "other",
			content: "other body",
			sourcePath: "/repo/b.md",
		});

		// Exactly three, not the inflated count sqlite's change counter reports
		// once the FTS triggers have added their own writes to it.
		expect(vault.deleteBySource("/repo/a.md")).toBe(3);
		expect(vault.deleteBySource("/repo/a.md")).toBe(0);
		expect(vault.knownSourcePaths("alpha")).toEqual(["/repo/b.md"]);
		expect(vault.stats().drawers).toBe(1);
	});
});

describe("vault rooms", () => {
	test("ensureRoom is idempotent and falls back to notes", () => {
		const vault = makeVault();
		expect(vault.ensureRoom("alpha", "design")).toBe("design");
		expect(vault.ensureRoom("alpha", "design")).toBe("design");
		expect(vault.ensureRoom("alpha", "   ")).toBe("notes");
		expect(vault.ensureRoom("alpha", "")).toBe("notes");

		expect(vault.listRooms("alpha").map(room => room.name)).toEqual(["design", "notes"]);
		expect(vault.listWings().map(wing => wing.name)).toEqual(["alpha"]);
	});

	test("wing and room counts follow the drawers", () => {
		const vault = makeVault();
		vault.addDrawer({ wing: "alpha", room: "design", title: "A", content: "body a" });
		vault.addDrawer({ wing: "alpha", room: "design", title: "B", content: "body b" });
		vault.addDrawer({ wing: "beta", room: "notes", title: "C", content: "body c" });

		expect(vault.listWings()).toEqual([
			{ name: "alpha", roomCount: 1, drawerCount: 2, updatedAt: expect.any(String) },
			{ name: "beta", roomCount: 1, drawerCount: 1, updatedAt: expect.any(String) },
		]);
		expect(vault.listRooms("alpha").map(room => room.drawerCount)).toEqual([2]);
		expect(vault.listRooms()).toHaveLength(2);
	});
});

describe("vault lexical search", () => {
	test("round-trips a match and survives FTS operator characters", () => {
		const vault = makeVault();
		const target = vault.addDrawer({
			wing: "alpha",
			room: "notes",
			title: "Retry policy",
			content: "the scheduler retries a failed mine with exponential backoff before giving up",
		});
		vault.addDrawer({ wing: "alpha", room: "notes", title: "Unrelated", content: "pancake recipes for a sunday" });

		const clean = vault.searchLexical("backoff");
		expect(clean.map(hit => hit.drawerId)).toEqual([target.id]);
		expect(clean[0].score).toBeGreaterThan(0);
		expect(clean[0].snippet.length).toBeGreaterThan(0);

		// A double quote is an unterminated string to FTS5, a bare `-` is column
		// exclusion, and `*` and `(` are syntax. None may reach the parser.
		const hostile = 'exponential" -backoff (scheduler)* "';
		expect(() => vault.searchLexical(hostile)).not.toThrow();
		expect(vault.searchLexical(hostile).map(hit => hit.drawerId)).toEqual([target.id]);

		// Nothing survives sanitizing, so there is no query to run.
		expect(vault.searchLexical('*** "" ---')).toEqual([]);
		expect(vault.searchLexical("   ")).toEqual([]);
	});

	test("ranks by match count and honours the filters", () => {
		const vault = makeVault();
		// Bodies are deliberately the same length. BM25 rewards shorter
		// documents, so an uncontrolled length difference would decide the
		// ranking instead of the thing under test — how many query terms hit.
		const both = vault.addDrawer({
			wing: "alpha",
			room: "notes",
			title: "Both terms",
			content: "mining scheduled during idle time",
			source: "handbook",
		});
		const one = vault.addDrawer({
			wing: "alpha",
			room: "archive",
			title: "One term",
			content: "scheduled during quiet idle time",
			source: "notes",
		});
		const otherWing = vault.addDrawer({
			wing: "beta",
			room: "notes",
			title: "Other wing",
			content: "mining scheduled during idle time",
			source: "handbook",
		});

		const hits = vault.searchLexical("mining scheduled");
		expect(hits.map(hit => hit.drawerId).sort()).toEqual([both.id, one.id, otherWing.id].sort());

		const scoreOf = (id: string): number => hits.find(hit => hit.drawerId === id)?.score ?? Number.NaN;
		expect(scoreOf(both.id)).toBeGreaterThan(scoreOf(one.id));
		// The ordering contract search.ts fuses on: best first, no exceptions.
		expect(hits.every((hit, index) => index === 0 || hits[index - 1].score >= hit.score)).toBe(true);

		expect(vault.searchLexical("mining scheduled", { wing: "beta" }).map(hit => hit.drawerId)).toEqual([
			otherWing.id,
		]);
		expect(
			vault.searchLexical("mining scheduled", { wing: "alpha", room: "notes" }).map(hit => hit.drawerId),
		).toEqual([both.id]);
		expect(
			vault
				.searchLexical("mining scheduled", { source: "handbook" })
				.map(hit => hit.drawerId)
				.sort(),
		).toEqual([both.id, otherWing.id].sort());
		expect(vault.searchLexical("mining scheduled", { limit: 1 })).toHaveLength(1);
	});
});

describe("vault vectors", () => {
	test("a deleted drawer takes its vector with it", () => {
		const vault = makeVault();
		const drawer = vault.addDrawer({ wing: "alpha", room: "notes", title: "Vectored", content: "embed me" });
		vault.putVector(drawer.id, "test-model", [1, 0, 0]);
		expect(vault.stats().vectors).toBe(1);

		expect(vault.deleteDrawer(drawer.id)).toBe(true);
		expect(vault.stats().vectors).toBe(0);
		expect(vault.deleteDrawer(drawer.id)).toBe(false);
	});

	test("putVector replaces the row for a model rather than adding one", () => {
		const vault = makeVault();
		const drawer = vault.addDrawer({ wing: "alpha", room: "notes", title: "Vectored", content: "embed me" });
		vault.putVector(drawer.id, "model-a", [1, 0, 0]);
		vault.putVector(drawer.id, "model-a", [0, 1, 0]);
		vault.putVector(drawer.id, "model-b", [0, 0, 1]);

		expect(vault.stats().vectors).toBe(2);
		expect(vault.searchVector([0, 1, 0], { model: "model-a" })[0].score).toBeCloseTo(1, 5);
	});

	test("searchVector ranks by cosine and skips dimension mismatches", () => {
		const vault = makeVault();
		const near = vault.addDrawer({ wing: "alpha", room: "notes", title: "Near", content: "near duplicate" });
		const orthogonal = vault.addDrawer({ wing: "alpha", room: "notes", title: "Away", content: "unrelated" });
		const mismatched = vault.addDrawer({ wing: "alpha", room: "notes", title: "Wrong", content: "wrong width" });

		vault.putVector(near.id, "m", [0.99, 0.14, 0]);
		vault.putVector(orthogonal.id, "m", [0, 0, 1]);
		// Two dimensions against a three-dimension query: skipped, not thrown on.
		vault.putVector(mismatched.id, "m", [1, 0]);

		const hits = vault.searchVector([1, 0, 0], { model: "m" });
		expect(hits.map(hit => hit.drawerId)).toEqual([near.id, orthogonal.id]);
		expect(hits[0].score).toBeGreaterThan(hits[1].score);
		expect(hits[0].score).toBeCloseTo(0.99, 2);
		expect(hits[1].score).toBeCloseTo(0, 5);

		expect(vault.searchVector([1, 0, 0], { model: "absent-model" })).toEqual([]);
		expect(vault.searchVector([], { model: "m" })).toEqual([]);
		expect(vault.searchVector([0, 0, 0], { model: "m" })).toEqual([]);
		expect(vault.searchVector([1, 0, 0], { model: "m", limit: 1 }).map(hit => hit.drawerId)).toEqual([near.id]);
		expect(vault.searchVector([1, 0, 0], { model: "m", wing: "beta" })).toEqual([]);
	});

	test("vector blobs survive the float32 round trip", () => {
		const vault = makeVault();
		const drawer = vault.addDrawer({ wing: "alpha", room: "notes", title: "Exact", content: "exact values" });
		// Powers of two are exact in float32, so a perfect self-match proves the
		// little-endian encode and decode agree.
		const stored = new Float32Array([0.5, -0.25, 0.125, 0]);
		vault.putVector(drawer.id, "m", stored);

		const hits = vault.searchVector(stored, { model: "m" });
		expect(hits.map(hit => hit.drawerId)).toEqual([drawer.id]);
		expect(hits[0].score).toBeCloseTo(1, 6);
	});

	test("pendingVectors lists only drawers missing that model's embedding", () => {
		const vault = makeVault();
		const first = vault.addDrawer({ wing: "alpha", room: "notes", title: "First", content: "first body" });
		const second = vault.addDrawer({ wing: "alpha", room: "notes", title: "Second", content: "second body" });

		expect(vault.pendingVectors("m", 10).map(row => row.drawerId)).toEqual([first.id, second.id]);

		vault.putVector(first.id, "m", [1, 0]);
		const pending = vault.pendingVectors("m", 10);
		expect(pending.map(row => row.drawerId)).toEqual([second.id]);
		expect(pending[0].text).toBe("Second\nsecond body");

		// A different model has seen nothing yet.
		expect(vault.pendingVectors("other", 10)).toHaveLength(2);
		expect(vault.pendingVectors("m", 0)).toEqual([]);
	});
});

describe("vault mining ledger", () => {
	test("round-trips a record and filters by wing", () => {
		const vault = makeVault();
		vault.recordMinedFile({
			path: "/repo/a.md",
			wing: "alpha",
			size: 120,
			mtimeMs: 1700000000123.5,
			contentHash: "hash-a",
			minedAt: "2026-01-01T00:00:00.000Z",
			drawerCount: 3,
		});
		vault.recordMinedFile({
			path: "/other/b.md",
			wing: "beta",
			size: 9,
			mtimeMs: 1700000000999,
			contentHash: "hash-b",
			minedAt: "2026-01-01T00:00:01.000Z",
			drawerCount: 1,
		});

		const all = vault.getMinedFiles();
		expect(all.size).toBe(2);
		expect(all.get("/repo/a.md")).toEqual({
			path: "/repo/a.md",
			wing: "alpha",
			size: 120,
			mtimeMs: 1700000000123.5,
			contentHash: "hash-a",
			minedAt: "2026-01-01T00:00:00.000Z",
			drawerCount: 3,
		});
		expect([...vault.getMinedFiles("alpha").keys()]).toEqual(["/repo/a.md"]);
		expect([...vault.getMinedFiles("beta").keys()]).toEqual(["/other/b.md"]);
		expect(vault.getMinedFiles("gamma").size).toBe(0);

		// A re-mine upserts on path instead of accumulating rows.
		vault.recordMinedFile({
			path: "/repo/a.md",
			wing: "alpha",
			size: 200,
			mtimeMs: 1700000009000,
			contentHash: "hash-a2",
			minedAt: "2026-01-02T00:00:00.000Z",
			drawerCount: 5,
		});
		const updated = vault.getMinedFiles("alpha").get("/repo/a.md");
		expect(updated?.size).toBe(200);
		expect(updated?.contentHash).toBe("hash-a2");
		expect(updated?.drawerCount).toBe(5);
		expect(vault.getMinedFiles().size).toBe(2);

		vault.forgetMinedFile("/repo/a.md");
		expect(vault.getMinedFiles().has("/repo/a.md")).toBe(false);
		expect(vault.getMinedFiles().size).toBe(1);
		// Forgetting an unknown path is a no-op, not an error.
		vault.forgetMinedFile("/repo/never-seen.md");
		expect(vault.getMinedFiles().size).toBe(1);
	});
});

describe("vault diary", () => {
	test("writes and reads entries per wing", () => {
		const vault = makeVault();
		const first = vault.writeDiary({ wing: "alpha", content: "found the backoff bug", tags: ["bug"] });
		const second = vault.writeDiary({ wing: "alpha", content: "shipped the fix" });
		vault.writeDiary({ wing: "beta", content: "unrelated wing" });

		expect(first.id.startsWith("dia_")).toBe(true);
		expect(first.tags).toEqual(["bug"]);

		const alpha = vault.readDiary({ wing: "alpha" });
		expect(alpha.map(entry => entry.id)).toEqual([second.id, first.id]);
		expect(alpha[1].content).toBe("found the backoff bug");
		expect(vault.readDiary()).toHaveLength(3);
		expect(vault.readDiary({ wing: "alpha", since: second.createdAt })).toHaveLength(1);
		expect(vault.readDiary({ limit: 1 })).toHaveLength(1);

		// A diary-only wing is still a wing.
		expect(vault.listWings().map(wing => wing.name)).toEqual(["alpha", "beta"]);
	});
});

describe("vault lifecycle", () => {
	test("stats counts every table and reports the newest write", () => {
		const vault = makeVault();
		const drawer = vault.addDrawer({ wing: "alpha", room: "design", title: "A", content: "body a" });
		vault.addDrawer({ wing: "beta", room: "notes", title: "B", content: "body b" });
		vault.putVector(drawer.id, "m", [1, 0]);
		vault.writeDiary({ wing: "alpha", content: "a line" });
		vault.recordMinedFile({
			path: "/repo/a.md",
			wing: "alpha",
			size: 1,
			mtimeMs: 1,
			contentHash: "h",
			minedAt: "2026-01-01T00:00:00.000Z",
			drawerCount: 1,
		});

		const stats = vault.stats();
		expect(stats.wings).toBe(2);
		expect(stats.rooms).toBe(2);
		expect(stats.drawers).toBe(2);
		expect(stats.diaryEntries).toBe(1);
		expect(stats.vectors).toBe(1);
		// :memory: has no file to measure.
		expect(stats.dbBytes).toBe(0);

		const newest = vault.readDiary()[0].createdAt;
		expect(stats.lastWriteAt).toBe(newest);
	});

	test("wipe empties the vault and leaves it usable", () => {
		const vault = makeVault();
		const drawer = vault.addDrawer({ wing: "alpha", room: "notes", title: "Before", content: "before the wipe" });
		vault.putVector(drawer.id, "m", [1, 0]);
		vault.writeDiary({ wing: "alpha", content: "a diary line" });
		vault.recordMinedFile({
			path: "/repo/a.md",
			wing: "alpha",
			size: 1,
			mtimeMs: 1,
			contentHash: "h",
			minedAt: "2026-01-01T00:00:00.000Z",
			drawerCount: 1,
		});

		vault.wipe();

		expect(vault.stats()).toEqual({ wings: 0, rooms: 0, drawers: 0, diaryEntries: 0, vectors: 0, dbBytes: 0 });
		expect(vault.getMinedFiles().size).toBe(0);
		expect(vault.listWings()).toEqual([]);
		expect(vault.readDiary()).toEqual([]);
		expect(vault.searchLexical("before")).toEqual([]);

		const after = vault.addDrawer({ wing: "alpha", room: "notes", title: "After", content: "after the wipe" });
		expect(after.created).toBe(true);
		expect(vault.searchLexical("after").map(hit => hit.drawerId)).toEqual([after.id]);
		expect(vault.stats().drawers).toBe(1);
		// A wipe that emptied the FTS index behind the triggers' back would leave
		// this delete failing with SQLITE_CORRUPT_VTAB.
		expect(vault.deleteDrawer(after.id)).toBe(true);
	});

	test("a file-backed vault creates its parent directory and persists across reopen", () => {
		const dbPath = path.join(makeTempDir(), "nested", "deeper", "palace.sqlite");

		const first = openVault({ path: dbPath });
		vaults.push(first);
		const written = first.addDrawer({ wing: "alpha", room: "notes", title: "Persisted", content: "on disk" });
		first.close();
		first.close(); // idempotent

		expect(fs.existsSync(dbPath)).toBe(true);

		const second = openVault({ path: dbPath });
		vaults.push(second);
		expect(second.path).toBe(dbPath);
		expect(second.getDrawer(written.id)?.content).toBe("on disk");
		expect(second.stats().drawers).toBe(1);
		expect(second.stats().dbBytes).toBeGreaterThan(0);
		expect(second.searchLexical("persisted").map(hit => hit.drawerId)).toEqual([written.id]);
	});

	test("openVault propagates when the database cannot be created", () => {
		const missing = path.join(makeTempDir(), "absent", "palace.sqlite");
		expect(() => openVault({ path: missing, createDirs: false })).toThrow();
	});

	test("a closed vault degrades to empty results instead of throwing", () => {
		const vault = makeVault();
		vault.addDrawer({ wing: "alpha", room: "notes", title: "Gone", content: "closed soon" });
		vault.close();

		expect(vault.listWings()).toEqual([]);
		expect(vault.listDrawers()).toEqual([]);
		expect(vault.searchLexical("closed")).toEqual([]);
		expect(vault.getMinedFiles().size).toBe(0);
		expect(vault.getDrawer("drw_anything")).toBeUndefined();
		expect(vault.stats().drawers).toBe(0);
	});
});
