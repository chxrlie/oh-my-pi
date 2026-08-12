/**
 * Serving layer for the native palace: query fusion, snippets, backfill of
 * missing vectors, and the wake-up orientation payload.
 *
 * This module owns no SQL and no filesystem access — it composes the vault's
 * synchronous primitives with one asynchronous dependency, the embedder. That
 * dependency is optional by design: a session with no local embeddings stack
 * still gets FTS5 results, it just gets told so through `effectiveMode` and
 * `message` rather than silently receiving fewer hits.
 *
 * Every entry point is failure-tolerant. A corrupt row, a vault that throws, an
 * embedder that dies mid-query — each degrades to the narrower answer and logs,
 * because a misconfigured memory store must never break an agent turn.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { DEFAULT_MEMPALACE_EMBED_MODEL } from "./embed";
import type {
	CreateSearcher,
	Drawer,
	EmbedFn,
	LexicalHit,
	Room,
	Searcher,
	SearcherOptions,
	SearchHit,
	SearchMode,
	SearchQuery,
	SearchResult,
	Vault,
	VectorHit,
	WakeUpContext,
	WakeUpOptions,
} from "./types";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_CANDIDATE_LIMIT = 50;
const DEFAULT_RRF_K = 60;

const DEFAULT_INDEX_LIMIT = 64;
/** Texts per embed round-trip while backfilling; keeps one IPC payload small. */
const INDEX_BATCH = 16;

const SNIPPET_CHARS = 200;
/** Window stride for snippet selection: a quarter window, so a match near a boundary still lands inside one. */
const SNIPPET_STEP = 50;

const DEFAULT_TOKEN_BUDGET = 900;
const MAX_INVENTORY_LINES = 8;
const MAX_HIGHLIGHTS = 5;
const MAX_DIARY_LINES = 3;
const HIGHLIGHT_CHARS = 120;
const DIARY_CHARS = 160;
/**
 * Over-fetch for wake-up surfaces. `listDrawers` and `readDiary` promise a
 * filter and a limit but no ordering, so recency is imposed here over a wider
 * slice instead of trusting whatever order the rows happen to arrive in.
 */
const WAKE_SCAN = 24;

/** Why a hybrid or vector request ran narrower than it was asked to. */
type DegradeReason = "no-embedder" | "embed-failed" | "empty-embedding";

const DEGRADE_MESSAGES: Record<DegradeReason, string> = {
	"no-embedder": "No embedder configured; ran lexical-only.",
	"embed-failed": "Embeddings unavailable; ran lexical-only.",
	"empty-embedding": "Query produced no embedding; ran lexical-only.",
};

/** One drawer's accumulated reciprocal-rank contributions across both legs. */
interface FusedEntry {
	score: number;
	lexical: boolean;
	vector: boolean;
	/** FTS5 excerpt, when the lexical leg produced one. */
	snippet?: string;
}

class NativeSearcher implements Searcher {
	readonly #vault: Vault;
	readonly #embed: EmbedFn | undefined;
	readonly #model: string;
	readonly #candidateLimit: number;
	readonly #rrfK: number;

	constructor(vault: Vault, options: SearcherOptions = {}) {
		this.#vault = vault;
		this.#embed = options.embed;
		this.#model = options.embedModel?.trim() || DEFAULT_MEMPALACE_EMBED_MODEL;
		this.#candidateLimit = positiveInt(options.candidateLimit, DEFAULT_CANDIDATE_LIMIT);
		this.#rrfK = positiveNumber(options.rrfK, DEFAULT_RRF_K);
	}

	async search(query: SearchQuery): Promise<SearchResult> {
		const mode = query.mode ?? "hybrid";
		const text = collapse(query.text ?? "");
		if (!text) return { query: text, mode, effectiveMode: "lexical", hits: [], message: "Empty query." };
		if (query.signal?.aborted) {
			return { query: text, mode, effectiveMode: "lexical", hits: [], message: "Search aborted." };
		}
		try {
			return await this.#runSearch(text, mode, query);
		} catch (error) {
			logger.warn("mempalace-native: search failed", { error: errorText(error) });
			return { query: text, mode, effectiveMode: "lexical", hits: [], message: "Search failed." };
		}
	}

	async #runSearch(text: string, mode: SearchMode, query: SearchQuery): Promise<SearchResult> {
		// The lexical leg is synchronous vault work, so it runs *before* the
		// embed await rather than after it: for hybrid that fills the IPC
		// round-trip for free. A pure vector request skips it unless the
		// embedder turns out to be unavailable.
		let lexical: LexicalHit[] = mode === "vector" ? [] : this.#lexical(text, query);
		let vector: VectorHit[] = [];
		let degraded: DegradeReason | undefined;

		if (mode !== "lexical") {
			const embedded = await this.#embedQuery(text, query.signal);
			if ("reason" in embedded) {
				degraded = embedded.reason;
				// A vector-only request still deserves an answer; falling back
				// beats reporting an empty palace to a caller that has one.
				if (mode === "vector") lexical = this.#lexical(text, query);
			} else if (!query.signal?.aborted) {
				vector = this.#vector(embedded.vector, query);
			}
		}

		const result: SearchResult = {
			query: text,
			mode,
			effectiveMode: degraded ? "lexical" : mode,
			hits: this.#fuse(text, query, lexical, vector),
		};
		if (degraded) result.message = DEGRADE_MESSAGES[degraded];
		return result;
	}

	/**
	 * Reciprocal rank fusion: each leg contributes `1 / (k + rank)` at 0-based
	 * rank, so a drawer both legs found outranks one either leg found alone,
	 * without BM25 and cosine ever having to be on a comparable scale.
	 */
	#fuse(text: string, query: SearchQuery, lexical: readonly LexicalHit[], vector: readonly VectorHit[]): SearchHit[] {
		const fused = new Map<string, FusedEntry>();
		for (let rank = 0; rank < lexical.length; rank++) {
			const hit = lexical[rank];
			const entry = fusedEntry(fused, hit.drawerId);
			entry.score += 1 / (this.#rrfK + rank);
			entry.lexical = true;
			if (!entry.snippet && hit.snippet) entry.snippet = hit.snippet;
		}
		for (let rank = 0; rank < vector.length; rank++) {
			const hit = vector[rank];
			const entry = fusedEntry(fused, hit.drawerId);
			entry.score += 1 / (this.#rrfK + rank);
			entry.vector = true;
		}
		if (fused.size === 0) return [];

		const limit = clampLimit(query.limit);
		const minScore = typeof query.minScore === "number" && Number.isFinite(query.minScore) ? query.minScore : 0;
		const ranked = [...fused]
			.filter(([, entry]) => entry.score >= minScore)
			.sort(([leftId, left], [rightId, right]) => right.score - left.score || compareStrings(leftId, rightId));
		if (ranked.length === 0) return [];

		// `VectorSearchOptions` carries no `source`, so the vector leg cannot
		// honour that filter and mismatches have to be dropped after hydration.
		// Dropping them *after* slicing to `limit` would return a short (or
		// empty) page while matching drawers sat just below the cut, so a
		// source-filtered query hydrates the whole candidate set instead.
		// Either way it is exactly one `getDrawers` call.
		const sourceFilter = query.source;
		const hydrateIds = (sourceFilter ? ranked : ranked.slice(0, limit)).map(([id]) => id);
		const drawers = this.#hydrate(hydrateIds);
		const terms = queryTerms(text);

		const hits: SearchHit[] = [];
		for (const [id, entry] of ranked) {
			if (hits.length >= limit) break;
			const drawer = drawers.get(id);
			// Deleted between the index scan and the hydrate; nothing to show.
			if (!drawer) continue;
			if (sourceFilter && drawer.source !== sourceFilter) continue;
			hits.push({
				drawerId: drawer.id,
				wing: drawer.wing,
				room: drawer.room,
				title: drawer.title,
				snippet: entry.snippet
					? truncateTo(collapse(entry.snippet), SNIPPET_CHARS)
					: synthesizeSnippet(drawer.content, terms),
				score: entry.score,
				source: drawer.source,
				sourcePath: drawer.sourcePath,
				createdAt: drawer.createdAt,
				matchedBy: entry.lexical && entry.vector ? "both" : entry.lexical ? "lexical" : "vector",
			});
		}
		return hits;
	}

	async indexPending(limit = DEFAULT_INDEX_LIMIT, signal?: AbortSignal): Promise<number> {
		const embed = this.#embed;
		if (!embed) return 0;
		if (signal?.aborted) return 0;
		const cap = positiveInt(limit, DEFAULT_INDEX_LIMIT);

		const rows = safeCall("pendingVectors", () => this.#vault.pendingVectors(this.#model, cap), []);
		let stored = 0;
		for (let start = 0; start < rows.length; start += INDEX_BATCH) {
			if (signal?.aborted) break;
			const batch = rows.slice(start, start + INDEX_BATCH);
			let vectors: number[][] | null;
			try {
				vectors = await embed(
					batch.map(row => row.text),
					signal,
				);
			} catch (error) {
				logger.debug("mempalace-native: embed threw during backfill", { error: errorText(error) });
				break;
			}
			// The embedder is gone, or the caller aborted mid-flight: keep what
			// is already durable rather than discarding the finished batches.
			if (!vectors) break;
			if (signal?.aborted) break;
			for (let index = 0; index < batch.length; index++) {
				const vector = vectors[index];
				if (!vector) continue;
				const drawerId = batch[index].drawerId;
				try {
					this.#vault.putVector(drawerId, this.#model, vector);
					stored++;
				} catch (error) {
					logger.debug("mempalace-native: putVector failed", { drawerId, error: errorText(error) });
				}
			}
		}
		return stored;
	}

	async wakeUp(options: WakeUpOptions = {}): Promise<WakeUpContext> {
		try {
			if (options.signal?.aborted) return emptyWakeUp();
			const budget = positiveInt(options.tokenBudget, DEFAULT_TOKEN_BUDGET);
			const active = options.wing?.trim() || undefined;

			const wings = safeCall("listWings", () => this.#vault.listWings(), []);
			const rooms = safeCall("listRooms", () => this.#vault.listRooms(), []);
			// The wing and room rollups should agree; take the larger so one that
			// has not caught up cannot understate the palace.
			const drawerCount = Math.max(
				wings.reduce((sum, wing) => sum + (wing.drawerCount || 0), 0),
				rooms.reduce((sum, room) => sum + (room.drawerCount || 0), 0),
			);
			const scope = active ? `; active wing ${active}` : "";
			const headline =
				`MemPalace: ${plural(drawerCount, "drawer")} in ${plural(rooms.length, "room")} ` +
				`across ${plural(wings.length, "wing")}${scope}.`;

			const inventory = buildInventory(rooms, active);
			const highlights = this.#buildHighlights(active);
			const diary = this.#buildDiary(active);

			// Shed from the tail: the least recent highlight first, then the
			// smallest room. The headline and the diary are the floor — they are
			// what a cold agent cannot reconstruct by querying the palace.
			let approxTokens = approxTokensOf(renderWake(headline, inventory, highlights, diary));
			while (approxTokens > budget && highlights.length > 0) {
				highlights.pop();
				approxTokens = approxTokensOf(renderWake(headline, inventory, highlights, diary));
			}
			while (approxTokens > budget && inventory.length > 0) {
				inventory.pop();
				approxTokens = approxTokensOf(renderWake(headline, inventory, highlights, diary));
			}
			return { headline, inventory, highlights, diary, approxTokens };
		} catch (error) {
			logger.warn("mempalace-native: wake-up failed", { error: errorText(error) });
			return emptyWakeUp();
		}
	}

	#buildHighlights(active: string | undefined): string[] {
		const filter = active ? { wing: active, limit: WAKE_SCAN } : { limit: WAKE_SCAN };
		const drawers = safeCall("listDrawers", () => this.#vault.listDrawers(filter), []);
		return [...drawers]
			.sort((left, right) => compareStrings(right.updatedAt, left.updatedAt) || compareStrings(left.id, right.id))
			.slice(0, MAX_HIGHLIGHTS)
			.map(highlightLine);
	}

	#buildDiary(active: string | undefined): string[] {
		const filter = active ? { wing: active, limit: WAKE_SCAN } : { limit: WAKE_SCAN };
		const entries = safeCall("readDiary", () => this.#vault.readDiary(filter), []);
		return [...entries]
			.sort((left, right) => compareStrings(right.createdAt, left.createdAt) || compareStrings(left.id, right.id))
			.slice(0, MAX_DIARY_LINES)
			.map(entry => `${entry.createdAt.slice(0, 10)} ${truncateTo(collapse(entry.content), DIARY_CHARS)}`.trim());
	}

	#lexical(text: string, query: SearchQuery): LexicalHit[] {
		return safeCall(
			"searchLexical",
			() =>
				this.#vault.searchLexical(text, {
					wing: query.wing,
					room: query.room,
					source: query.source,
					limit: this.#candidateLimit,
				}),
			[],
		);
	}

	#vector(vector: readonly number[], query: SearchQuery): VectorHit[] {
		return safeCall(
			"searchVector",
			() =>
				this.#vault.searchVector(vector, {
					wing: query.wing,
					room: query.room,
					model: this.#model,
					limit: this.#candidateLimit,
				}),
			[],
		);
	}

	#hydrate(ids: readonly string[]): Map<string, Drawer> {
		const byId = new Map<string, Drawer>();
		for (const drawer of safeCall("getDrawers", () => this.#vault.getDrawers(ids), [])) {
			byId.set(drawer.id, drawer);
		}
		return byId;
	}

	/** Embed one query, reporting *why* it could not rather than just that it could not. */
	async #embedQuery(
		text: string,
		signal: AbortSignal | undefined,
	): Promise<{ vector: number[] } | { reason: DegradeReason }> {
		const embed = this.#embed;
		if (!embed) return { reason: "no-embedder" };
		let vectors: number[][] | null;
		try {
			vectors = await embed([text], signal);
		} catch (error) {
			// `EmbedFn` promises to resolve `null` rather than throw, but a
			// third-party implementation is not bound by good intentions.
			logger.debug("mempalace-native: query embed threw", { error: errorText(error) });
			return { reason: "embed-failed" };
		}
		if (!vectors) return { reason: "embed-failed" };
		const vector = vectors[0];
		if (!vector || vector.length === 0) return { reason: "empty-embedding" };
		return { vector };
	}
}

export const createSearcher: CreateSearcher = (vault, options) => new NativeSearcher(vault, options);

function fusedEntry(fused: Map<string, FusedEntry>, drawerId: string): FusedEntry {
	let entry = fused.get(drawerId);
	if (!entry) {
		entry = { score: 0, lexical: false, vector: false };
		fused.set(drawerId, entry);
	}
	return entry;
}

function buildInventory(rooms: readonly Room[], active: string | undefined): string[] {
	const byDrawerCount = (left: Room, right: Room) =>
		right.drawerCount - left.drawerCount || compareStrings(left.name, right.name);
	const activeRooms = active ? rooms.filter(room => room.wing === active).sort(byDrawerCount) : [];
	const otherRooms = rooms.filter(room => room.wing !== active).sort(byDrawerCount);
	return [...activeRooms, ...otherRooms]
		.slice(0, MAX_INVENTORY_LINES)
		.map(room => `${room.wing}/${room.name} (${room.drawerCount})`);
}

function highlightLine(drawer: Drawer): string {
	const title = collapse(drawer.title) || drawer.id;
	const body = collapse(drawer.content);
	return body ? `${title} — ${truncateTo(body, HIGHLIGHT_CHARS)}` : title;
}

/**
 * The rendered wake-up payload, and the exact string `approxTokens` measures:
 * headline, inventory, highlights, diary — one line each, in that order.
 */
function renderWake(
	headline: string,
	inventory: readonly string[],
	highlights: readonly string[],
	diary: readonly string[],
): string {
	return [headline, ...inventory, ...highlights, ...diary].join("\n");
}

function approxTokensOf(text: string): number {
	return Math.ceil(text.length / 4);
}

function emptyWakeUp(): WakeUpContext {
	return { headline: "", inventory: [], highlights: [], diary: [], approxTokens: 0 };
}

/**
 * Pick the ~200-character window with the widest coverage of the query's word
 * set. Ties go to the earliest window, and a query whose words appear nowhere
 * (a pure vector match on a paraphrase) falls back to the head of the drawer.
 */
function synthesizeSnippet(content: string, terms: readonly string[]): string {
	const text = collapse(content);
	if (text.length <= SNIPPET_CHARS) return text;
	const haystack = text.toLowerCase();
	let bestStart = 0;
	let bestScore = 0;
	for (let start = 0; start < text.length; start += SNIPPET_STEP) {
		const window = haystack.slice(start, start + SNIPPET_CHARS);
		let score = 0;
		for (const term of terms) {
			if (window.includes(term)) score++;
		}
		if (score > bestScore) {
			bestScore = score;
			bestStart = start;
		}
	}
	const end = bestStart + SNIPPET_CHARS;
	const head = bestStart > 0 ? "…" : "";
	const tail = end < text.length ? "…" : "";
	return `${head}${text.slice(bestStart, end).trim()}${tail}`;
}

/** Distinct lowercase words of two characters or more; single letters are noise. */
function queryTerms(text: string): string[] {
	const terms = new Set<string>();
	for (const term of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
		if (term.length >= 2) terms.add(term);
	}
	return [...terms];
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateTo(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function clampLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function positiveInt(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
	return Math.floor(value);
}

function positiveNumber(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return value;
}

/** Run one vault primitive, trading a throw for the caller's empty case. */
function safeCall<T>(label: string, run: () => T, fallback: T): T {
	try {
		return run();
	} catch (error) {
		logger.debug(`mempalace-native: vault.${label} failed`, { error: errorText(error) });
		return fallback;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
