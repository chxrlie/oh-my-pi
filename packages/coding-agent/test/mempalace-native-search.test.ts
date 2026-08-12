import { describe, expect, test } from "bun:test";
import { createSearcher } from "../src/mempalace-native/search";
import type {
	DiaryEntry,
	Drawer,
	DrawerFilter,
	EmbedFn,
	LexicalHit,
	PendingVectorRow,
	Room,
	Vault,
	VectorHit,
	WakeUpContext,
	Wing,
} from "../src/mempalace-native/types";

/**
 * The searcher owns no storage, so every test drives it through a hand-rolled
 * `Vault` — a plain object implementing the contract, recording the calls that
 * matter and returning canned rows. Nothing here touches sqlite, the
 * filesystem, a subprocess, or the network.
 */

const EPOCH = "2026-01-01T00:00:00.000Z";

interface VaultSeed {
	drawers?: Drawer[];
	lexical?: LexicalHit[];
	vector?: VectorHit[];
	pending?: PendingVectorRow[];
	diary?: DiaryEntry[];
	wings?: Wing[];
	rooms?: Room[];
	/** Make every read throw, to exercise the degradation paths. */
	hostile?: boolean;
}

interface VaultCalls {
	lexical: { query: string; limit?: number; source?: string }[];
	vector: { model: string; dims: number; limit?: number }[];
	getDrawers: string[][];
	pendingVectors: { model: string; limit: number }[];
	putVector: { drawerId: string; model: string; dims: number }[];
	listDrawers: (DrawerFilter | undefined)[];
}

function createFakeVault(seed: VaultSeed = {}): { vault: Vault; calls: VaultCalls } {
	const drawers = new Map((seed.drawers ?? []).map((drawer): [string, Drawer] => [drawer.id, drawer]));
	const calls: VaultCalls = {
		lexical: [],
		vector: [],
		getDrawers: [],
		pendingVectors: [],
		putVector: [],
		listDrawers: [],
	};
	const hostile = () => {
		if (seed.hostile) throw new Error("vault is unavailable");
	};

	const vault: Vault = {
		path: ":memory:",

		listWings: () => {
			hostile();
			return [...(seed.wings ?? [])];
		},
		listRooms: wing => {
			hostile();
			return (seed.rooms ?? []).filter(room => wing === undefined || room.wing === wing);
		},
		ensureRoom: (_wing, room) => room,

		addDrawer: () => ({ id: "unused", created: false, updated: false }),
		addDrawers: inputs => inputs.map(() => ({ id: "unused", created: false, updated: false })),
		getDrawer: id => drawers.get(id),
		getDrawers: ids => {
			calls.getDrawers.push([...ids]);
			hostile();
			const found: Drawer[] = [];
			for (const id of ids) {
				const drawer = drawers.get(id);
				if (drawer) found.push(drawer);
			}
			return found;
		},
		updateDrawer: () => false,
		deleteDrawer: () => false,
		deleteBySource: () => 0,
		listDrawers: filter => {
			calls.listDrawers.push(filter);
			hostile();
			const wing = filter?.wing;
			const matching = [...drawers.values()].filter(drawer => wing === undefined || drawer.wing === wing);
			return matching.slice(0, filter?.limit ?? 50);
		},
		knownSourcePaths: () => [],

		getMinedFiles: () => new Map(),
		recordMinedFile: () => {},
		forgetMinedFile: () => {},

		searchLexical: (query, options) => {
			calls.lexical.push({ query, limit: options?.limit, source: options?.source });
			hostile();
			return [...(seed.lexical ?? [])];
		},

		putVector: (drawerId, model, vector) => {
			calls.putVector.push({ drawerId, model, dims: vector.length });
		},
		pendingVectors: (model, limit) => {
			calls.pendingVectors.push({ model, limit });
			return (seed.pending ?? []).slice(0, limit);
		},
		searchVector: (query, options) => {
			calls.vector.push({ model: options.model, dims: query.length, limit: options.limit });
			hostile();
			return [...(seed.vector ?? [])];
		},

		writeDiary: input => ({
			id: "diary-new",
			wing: input.wing,
			content: input.content,
			tags: [...(input.tags ?? [])],
			createdAt: EPOCH,
		}),
		readDiary: options => {
			hostile();
			const wing = options?.wing;
			return (seed.diary ?? [])
				.filter(entry => wing === undefined || entry.wing === wing)
				.slice(0, options?.limit ?? 50);
		},

		stats: () => ({
			wings: (seed.wings ?? []).length,
			rooms: (seed.rooms ?? []).length,
			drawers: drawers.size,
			diaryEntries: (seed.diary ?? []).length,
			vectors: 0,
			dbBytes: 0,
		}),
		wipe: () => {},
		close: () => {},
	};

	return { vault, calls };
}

function makeDrawer(id: string, overrides: Partial<Drawer> = {}): Drawer {
	return {
		id,
		wing: "alpha",
		room: "notes",
		title: `Drawer ${id}`,
		content: `Content for ${id}.`,
		origin: "manual",
		addedBy: "omp",
		tags: [],
		contentHash: `hash-${id}`,
		createdAt: EPOCH,
		updatedAt: EPOCH,
		...overrides,
	};
}

interface StubEmbedder {
	embed: EmbedFn;
	/** One entry per call: how many texts that call was handed. */
	batches: number[];
}

/**
 * A deterministic stand-in for the local embeddings worker. It deliberately
 * ignores `signal` so the abort assertions prove the *searcher* honours it.
 */
function stubEmbedder(options: { dims?: number; onCall?: (callIndex: number) => void } = {}): StubEmbedder {
	const batches: number[] = [];
	const dims = options.dims ?? 4;
	const embed: EmbedFn = async texts => {
		const callIndex = batches.length;
		batches.push(texts.length);
		options.onCall?.(callIndex);
		return texts.map((_, textIndex) => Array.from({ length: dims }, (_, unit) => (textIndex + unit + 1) / 10));
	};
	return { embed, batches };
}

/** The rendered wake-up payload the searcher measures: one line per element, in order. */
function renderedTokens(context: Pick<WakeUpContext, "headline" | "inventory" | "highlights" | "diary">): number {
	const rendered = [context.headline, ...context.inventory, ...context.highlights, ...context.diary].join("\n");
	return Math.ceil(rendered.length / 4);
}

/** A, B, C: A is found by both legs, B only lexically, C only by vector. */
function fusionSeed(overrides: Partial<VaultSeed> = {}): VaultSeed {
	return {
		drawers: [
			makeDrawer("A", { title: "Alpha", content: "Alpha body." }),
			makeDrawer("B", { title: "Beta", content: "Beta body." }),
			makeDrawer("C", { title: "Gamma", content: "Gamma body." }),
		],
		lexical: [
			{ drawerId: "A", score: 2.5, snippet: "alpha snippet" },
			{ drawerId: "B", score: 1.5, snippet: "beta snippet" },
		],
		vector: [
			{ drawerId: "C", score: 0.91 },
			{ drawerId: "A", score: 0.82 },
		],
		...overrides,
	};
}

const RRF_BOTH = 1 / 60 + 1 / 61;
const RRF_FIRST = 1 / 60;
const RRF_SECOND = 1 / 61;

describe("createSearcher — reciprocal rank fusion", () => {
	test("ranks a drawer found by both legs above either single-leg drawer", async () => {
		const { vault, calls } = createFakeVault(fusionSeed());
		const searcher = createSearcher(vault, { embed: stubEmbedder().embed });

		const result = await searcher.search({ text: "alpha gamma" });

		expect(result.mode).toBe("hybrid");
		expect(result.effectiveMode).toBe("hybrid");
		expect(result.message).toBeUndefined();
		// A: 1/60 (lexical rank 0) + 1/61 (vector rank 1). C: 1/60. B: 1/61.
		expect(result.hits.map(hit => hit.drawerId)).toEqual(["A", "C", "B"]);
		expect(result.hits[0].score).toBeCloseTo(RRF_BOTH, 12);
		expect(result.hits[1].score).toBeCloseTo(RRF_FIRST, 12);
		expect(result.hits[2].score).toBeCloseTo(RRF_SECOND, 12);
		expect(result.hits[0].score).toBeGreaterThan(result.hits[1].score);
		// One hydrate for the whole page, not one per hit.
		expect(calls.getDrawers).toEqual([["A", "C", "B"]]);
	});

	test("labels matchedBy for the both / lexical / vector cases", async () => {
		const { vault } = createFakeVault(fusionSeed());
		const searcher = createSearcher(vault, { embed: stubEmbedder().embed });

		const result = await searcher.search({ text: "alpha gamma" });

		const matchedBy = Object.fromEntries(result.hits.map(hit => [hit.drawerId, hit.matchedBy]));
		expect(matchedBy).toEqual({ A: "both", C: "vector", B: "lexical" });
	});

	test("honours limit and drops hits below minScore", async () => {
		const { vault } = createFakeVault(fusionSeed());
		const searcher = createSearcher(vault, { embed: stubEmbedder().embed });

		const limited = await searcher.search({ text: "alpha gamma", limit: 1 });
		expect(limited.hits.map(hit => hit.drawerId)).toEqual(["A"]);

		// Between B's 1/61 and C's 1/60: B falls out, C stays.
		const filtered = await searcher.search({ text: "alpha gamma", minScore: 0.0165 });
		expect(filtered.hits.map(hit => hit.drawerId)).toEqual(["A", "C"]);

		// minScore is inclusive, so a hit sitting exactly on the threshold survives.
		const boundary = await searcher.search({ text: "alpha gamma", minScore: RRF_FIRST });
		expect(boundary.hits.map(hit => hit.drawerId)).toEqual(["A", "C"]);

		const impossible = await searcher.search({ text: "alpha gamma", minScore: 1 });
		expect(impossible.hits).toEqual([]);
	});

	test("skips a fused candidate whose drawer row no longer exists", async () => {
		const seed = fusionSeed();
		// B ranks lexically but was deleted before the hydrate.
		const { vault } = createFakeVault({ ...seed, drawers: seed.drawers?.filter(drawer => drawer.id !== "B") });
		const searcher = createSearcher(vault, { embed: stubEmbedder().embed });

		const result = await searcher.search({ text: "alpha gamma" });

		expect(result.hits.map(hit => hit.drawerId)).toEqual(["A", "C"]);
	});
});

describe("createSearcher — degradation", () => {
	test("hybrid with a null-returning embedder falls back to lexical-only", async () => {
		const { vault, calls } = createFakeVault(fusionSeed());
		const searcher = createSearcher(vault, { embed: async () => null });

		const result = await searcher.search({ text: "alpha gamma" });

		expect(result.mode).toBe("hybrid");
		expect(result.effectiveMode).toBe("lexical");
		expect(result.message).toContain("lexical-only");
		expect(result.hits.map(hit => hit.drawerId)).toEqual(["A", "B"]);
		expect(result.hits.every(hit => hit.matchedBy === "lexical")).toBe(true);
		expect(calls.vector).toEqual([]);
	});

	test("hybrid degrades when the query embeds to nothing", async () => {
		const { vault, calls } = createFakeVault(fusionSeed());
		const searcher = createSearcher(vault, { embed: async () => [[]] });

		const result = await searcher.search({ text: "alpha gamma" });

		expect(result.effectiveMode).toBe("lexical");
		expect(result.message).toContain("lexical-only");
		expect(result.hits.map(hit => hit.drawerId)).toEqual(["A", "B"]);
		expect(calls.vector).toEqual([]);
	});

	test("mode vector with no embedder degrades instead of returning nothing", async () => {
		const { vault } = createFakeVault(fusionSeed());
		const searcher = createSearcher(vault);

		const result = await searcher.search({ text: "alpha gamma", mode: "vector" });

		expect(result.mode).toBe("vector");
		expect(result.effectiveMode).toBe("lexical");
		expect(result.message).toContain("lexical-only");
		expect(result.hits.map(hit => hit.drawerId)).toEqual(["A", "B"]);
	});

	test("mode lexical never touches the embedder", async () => {
		const { vault, calls } = createFakeVault(fusionSeed());
		const embedder = stubEmbedder();
		const searcher = createSearcher(vault, { embed: embedder.embed });

		const result = await searcher.search({ text: "alpha gamma", mode: "lexical" });

		expect(embedder.batches).toEqual([]);
		expect(calls.vector).toEqual([]);
		expect(result.effectiveMode).toBe("lexical");
		// Nothing was degraded, so nothing is explained away.
		expect(result.message).toBeUndefined();
		expect(result.hits.map(hit => hit.drawerId)).toEqual(["A", "B"]);
	});

	test("a vault that throws yields an empty result rather than an exception", async () => {
		const { vault } = createFakeVault({ ...fusionSeed(), hostile: true });
		const searcher = createSearcher(vault, { embed: stubEmbedder().embed });

		const result = await searcher.search({ text: "alpha gamma" });

		expect(result.hits).toEqual([]);
		expect(result.query).toBe("alpha gamma");
	});
});

describe("createSearcher — snippets", () => {
	const FILLER = "Filler prose about unrelated matters that fills the drawer. ".repeat(8);
	const NEEDLE = "The lattice keeps its gravity wells stable under sustained load.";

	test("synthesizes a window around the query words for a vector-only hit", async () => {
		const { vault } = createFakeVault({
			drawers: [makeDrawer("C", { title: "Gamma", content: `${FILLER}\n\n   ${NEEDLE}   \n\n${FILLER}` })],
			lexical: [],
			vector: [{ drawerId: "C", score: 0.93 }],
		});
		const searcher = createSearcher(vault, { embed: stubEmbedder().embed });

		const result = await searcher.search({ text: "gravity wells" });

		expect(result.hits).toHaveLength(1);
		const snippet = result.hits[0].snippet;
		expect(result.hits[0].matchedBy).toBe("vector");
		expect(snippet).toContain("gravity");
		expect(snippet).toContain("wells");
		// Truncated, and whitespace runs collapsed to single spaces.
		expect(snippet).toContain("…");
		expect(snippet).not.toContain("  ");
		expect(snippet).not.toContain("\n");
		expect(snippet.length).toBeLessThanOrEqual(202);
	});

	test("falls back to the head of the drawer when no query word appears", async () => {
		const { vault } = createFakeVault({
			drawers: [makeDrawer("C", { content: `${FILLER}${FILLER}` })],
			lexical: [],
			vector: [{ drawerId: "C", score: 0.5 }],
		});
		const searcher = createSearcher(vault, { embed: stubEmbedder().embed });

		const result = await searcher.search({ text: "gravity wells" });

		expect(result.hits[0].snippet.startsWith("Filler prose about unrelated")).toBe(true);
		expect(result.hits[0].snippet.endsWith("…")).toBe(true);
	});

	test("prefers the vault's FTS excerpt when the lexical leg produced one", async () => {
		const { vault } = createFakeVault(fusionSeed());
		const searcher = createSearcher(vault, { embed: stubEmbedder().embed });

		const result = await searcher.search({ text: "alpha gamma" });

		expect(result.hits[0].snippet).toBe("alpha snippet");
	});
});

describe("createSearcher — indexPending", () => {
	function pendingRows(count: number): PendingVectorRow[] {
		return Array.from({ length: count }, (_, index) => ({
			drawerId: `p${index + 1}`,
			text: `pending text ${index + 1}`,
		}));
	}

	test("stores one vector per pending row", async () => {
		const { vault, calls } = createFakeVault({ pending: pendingRows(3) });
		const embedder = stubEmbedder({ dims: 3 });
		const searcher = createSearcher(vault, { embed: embedder.embed, embedModel: "test-model" });

		const stored = await searcher.indexPending();

		expect(stored).toBe(3);
		expect(embedder.batches).toEqual([3]);
		expect(calls.pendingVectors).toEqual([{ model: "test-model", limit: 64 }]);
		expect(calls.putVector).toEqual([
			{ drawerId: "p1", model: "test-model", dims: 3 },
			{ drawerId: "p2", model: "test-model", dims: 3 },
			{ drawerId: "p3", model: "test-model", dims: 3 },
		]);
	});

	test("embeds in batches of 16", async () => {
		const { vault, calls } = createFakeVault({ pending: pendingRows(20) });
		const embedder = stubEmbedder();
		const searcher = createSearcher(vault, { embed: embedder.embed, embedModel: "test-model" });

		const stored = await searcher.indexPending(20);

		expect(embedder.batches).toEqual([16, 4]);
		expect(stored).toBe(20);
		expect(calls.putVector).toHaveLength(20);
		expect(calls.pendingVectors).toEqual([{ model: "test-model", limit: 20 }]);
	});

	test("stops on abort and keeps what it already stored", async () => {
		const controller = new AbortController();
		const { vault, calls } = createFakeVault({ pending: pendingRows(20) });
		// Abort while the second batch is in flight; the first is already durable.
		const embedder = stubEmbedder({
			onCall: callIndex => {
				if (callIndex === 1) controller.abort();
			},
		});
		const searcher = createSearcher(vault, { embed: embedder.embed, embedModel: "test-model" });

		const stored = await searcher.indexPending(20, controller.signal);

		expect(embedder.batches).toEqual([16, 4]);
		expect(stored).toBe(16);
		expect(calls.putVector).toHaveLength(16);
	});

	test("returns 0 and reads nothing when no embedder is configured", async () => {
		const { vault, calls } = createFakeVault({ pending: pendingRows(5) });
		const searcher = createSearcher(vault);

		expect(await searcher.indexPending()).toBe(0);
		expect(calls.pendingVectors).toEqual([]);
		expect(calls.putVector).toEqual([]);
	});

	test("returns 0 when the signal is already aborted", async () => {
		const { vault, calls } = createFakeVault({ pending: pendingRows(5) });
		const embedder = stubEmbedder();
		const searcher = createSearcher(vault, { embed: embedder.embed });

		expect(await searcher.indexPending(5, AbortSignal.abort())).toBe(0);
		expect(embedder.batches).toEqual([]);
		expect(calls.putVector).toEqual([]);
	});
});

describe("createSearcher — wakeUp", () => {
	const BODY = "A long drawer body that comfortably exceeds the highlight excerpt budget. ".repeat(4);

	function wakeSeed(): VaultSeed {
		return {
			wings: [
				{ name: "alpha", roomCount: 2, drawerCount: 7, updatedAt: EPOCH },
				{ name: "beta", roomCount: 1, drawerCount: 2, updatedAt: EPOCH },
			],
			rooms: [
				{ wing: "beta", name: "logs", drawerCount: 2, updatedAt: EPOCH },
				{ wing: "alpha", name: "specs", drawerCount: 2, updatedAt: EPOCH },
				{ wing: "alpha", name: "notes", drawerCount: 5, updatedAt: EPOCH },
			],
			// Deliberately out of recency order: the searcher must sort, not trust.
			drawers: [
				makeDrawer("d3", { title: "Third", content: BODY, updatedAt: "2026-03-03T00:00:00.000Z" }),
				makeDrawer("d6", { title: "Newest", content: BODY, updatedAt: "2026-03-06T00:00:00.000Z" }),
				makeDrawer("d1", { title: "Oldest", content: BODY, updatedAt: "2026-03-01T00:00:00.000Z" }),
				makeDrawer("d5", { title: "Fifth", content: BODY, updatedAt: "2026-03-05T00:00:00.000Z" }),
				makeDrawer("d2", { title: "Second", content: BODY, updatedAt: "2026-03-02T00:00:00.000Z" }),
				makeDrawer("d4", { title: "Fourth", content: BODY, updatedAt: "2026-03-04T00:00:00.000Z" }),
				makeDrawer("b1", { wing: "beta", room: "logs", title: "Other wing", content: BODY }),
			],
			diary: [
				{ id: "e1", wing: "alpha", content: "Diary one", tags: [], createdAt: "2026-03-07T00:00:00.000Z" },
				{ id: "e3", wing: "alpha", content: "Diary three", tags: [], createdAt: "2026-03-09T00:00:00.000Z" },
				{ id: "e2", wing: "alpha", content: "Diary two", tags: [], createdAt: "2026-03-08T00:00:00.000Z" },
				{ id: "e0", wing: "alpha", content: "Diary zero", tags: [], createdAt: "2026-03-06T00:00:00.000Z" },
			],
		};
	}

	test("builds a headline, inventory, highlights and diary for the active wing", async () => {
		const { vault } = createFakeVault(wakeSeed());
		const searcher = createSearcher(vault);

		const context = await searcher.wakeUp({ wing: "alpha", tokenBudget: 10_000 });

		expect(context.headline).toBe("MemPalace: 9 drawers in 3 rooms across 2 wings; active wing alpha.");
		// Active wing first, largest room first inside each group.
		expect(context.inventory).toEqual(["alpha/notes (5)", "alpha/specs (2)", "beta/logs (2)"]);
		expect(context.highlights).toHaveLength(5);
		expect(context.highlights[0].startsWith("Newest — ")).toBe(true);
		expect(context.highlights[4].startsWith("Second — ")).toBe(true);
		expect(context.highlights.every(line => !line.includes("Other wing"))).toBe(true);
		expect(context.diary).toEqual(["2026-03-09 Diary three", "2026-03-08 Diary two", "2026-03-07 Diary one"]);
		expect(context.approxTokens).toBe(renderedTokens(context));
	});

	test("sheds highlights before inventory to fit the token budget", async () => {
		const { vault } = createFakeVault(wakeSeed());
		const searcher = createSearcher(vault);

		const full = await searcher.wakeUp({ wing: "alpha", tokenBudget: 10_000 });
		const withoutHighlights = renderedTokens({ ...full, highlights: [] });
		expect(withoutHighlights).toBeLessThan(full.approxTokens);

		const trimmed = await searcher.wakeUp({ wing: "alpha", tokenBudget: withoutHighlights });

		expect(trimmed.highlights).toEqual([]);
		// Inventory and diary are untouched: highlights absorb the whole cut.
		expect(trimmed.inventory).toEqual(full.inventory);
		expect(trimmed.diary).toEqual(full.diary);
		expect(trimmed.approxTokens).toBe(withoutHighlights);
		expect(trimmed.approxTokens).toBe(renderedTokens(trimmed));
	});

	test("sheds inventory once highlights are gone, keeping headline and diary", async () => {
		const { vault } = createFakeVault(wakeSeed());
		const searcher = createSearcher(vault);

		const full = await searcher.wakeUp({ wing: "alpha", tokenBudget: 10_000 });
		const tiny = await searcher.wakeUp({ wing: "alpha", tokenBudget: 1 });

		expect(tiny.highlights).toEqual([]);
		expect(tiny.inventory).toEqual([]);
		expect(tiny.headline).toBe(full.headline);
		expect(tiny.diary).toEqual(full.diary);
		expect(tiny.approxTokens).toBe(renderedTokens(tiny));
		expect(tiny.approxTokens).toBeLessThan(full.approxTokens);
	});

	test("omits the active wing from the headline when none is given", async () => {
		const { vault } = createFakeVault(wakeSeed());
		const searcher = createSearcher(vault);

		const context = await searcher.wakeUp({ tokenBudget: 10_000 });

		expect(context.headline).toBe("MemPalace: 9 drawers in 3 rooms across 2 wings.");
		expect(context.approxTokens).toBe(renderedTokens(context));
	});

	test("returns an empty but valid context when every vault read throws", async () => {
		const { vault } = createFakeVault({ ...wakeSeed(), hostile: true });
		const searcher = createSearcher(vault);

		const context = await searcher.wakeUp({ wing: "alpha" });

		expect(context.inventory).toEqual([]);
		expect(context.highlights).toEqual([]);
		expect(context.diary).toEqual([]);
		expect(typeof context.headline).toBe("string");
		expect(context.approxTokens).toBe(renderedTokens(context));
	});

	test("returns an empty context for an already-aborted signal", async () => {
		const { vault } = createFakeVault(wakeSeed());
		const searcher = createSearcher(vault);

		const context = await searcher.wakeUp({ wing: "alpha", signal: AbortSignal.abort() });

		expect(context).toEqual({ headline: "", inventory: [], highlights: [], diary: [], approxTokens: 0 });
	});
});
