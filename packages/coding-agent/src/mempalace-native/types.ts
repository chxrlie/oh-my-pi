/**
 * Shared contract for the native (TypeScript) MemPalace store.
 *
 * The sibling `src/mempalace/` subsystem delegates every read and write to the
 * Python `mempalace` package over MCP stdio and its CLI. This subsystem owns an
 * independent, original implementation of the same *concepts* — wings, rooms,
 * drawers, diary, mining, hybrid search — backed by `bun:sqlite` and the local
 * embeddings worker, so a session needs no Python at all.
 *
 * Layering, and the module that owns each half:
 *
 *   `vault.ts`   — storage. Schema, migrations, CRUD, content-hash dedup,
 *                  FTS5 lexical matching, vector blob persistence and cosine
 *                  scan. Synchronous; never embeds, never walks the filesystem.
 *   `search.ts`  — serving. Embedding orchestration, lexical/vector fusion,
 *                  snippets, token budgeting, wake-up context. Async; owns no
 *                  SQL.
 *   `miner.ts`   — ingest. Filesystem walk, chunking, convo-mode routing,
 *                  prune of vanished sources. Async; writes through the vault.
 *   `backend.ts` — the `MemoryBackend` adapter that binds the three together
 *                  for `memory.backend: mempalace-native`.
 *
 * Every identifier below is load-bearing across module boundaries: the modules
 * are written independently and only agree through this file.
 */

/** ISO-8601 timestamp string, always UTC (`new Date().toISOString()`). */
export type IsoTimestamp = string;

/**
 * How a drawer entered the palace. `manual` is a model or user write, `mined`
 * came from a filesystem walk, `convo` from a harness session transcript,
 * `diary` from the diary surface.
 */
export type DrawerOrigin = "manual" | "mined" | "convo" | "diary";

/** A top-level partition of the palace, derived from a project directory name. */
export interface Wing {
	name: string;
	roomCount: number;
	drawerCount: number;
	updatedAt: IsoTimestamp;
}

/** A named grouping of drawers inside one wing. */
export interface Room {
	wing: string;
	name: string;
	drawerCount: number;
	updatedAt: IsoTimestamp;
}

/** One stored unit of memory. */
export interface Drawer {
	id: string;
	wing: string;
	room: string;
	title: string;
	content: string;
	/** Free-form provenance label, e.g. a tool name or `omp`. */
	source?: string;
	/** Absolute path of the file this drawer was mined from, when applicable. */
	sourcePath?: string;
	origin: DrawerOrigin;
	/** Writer identity; the harness always stamps `omp`. */
	addedBy: string;
	tags: string[];
	/** SHA-256 of the normalized content; the dedup key within a wing. */
	contentHash: string;
	createdAt: IsoTimestamp;
	updatedAt: IsoTimestamp;
}

/** Fields accepted when filing a new drawer. Everything optional is defaulted by the vault. */
export interface DrawerInput {
	wing: string;
	room: string;
	title: string;
	content: string;
	source?: string;
	sourcePath?: string;
	origin?: DrawerOrigin;
	addedBy?: string;
	tags?: readonly string[];
}

/** Mutable subset of a drawer. Omitted keys are left untouched. */
export interface DrawerPatch {
	title?: string;
	content?: string;
	room?: string;
	tags?: readonly string[];
	source?: string;
}

/** Outcome of a single drawer write. */
export interface DrawerWriteResult {
	id: string;
	/** `false` when an identical `contentHash` already existed in the wing. */
	created: boolean;
	/** `true` when an existing drawer's mutable fields were refreshed in place. */
	updated: boolean;
}

/** Filter for `listDrawers`. All fields AND together; omitted fields do not constrain. */
export interface DrawerFilter {
	wing?: string;
	room?: string;
	source?: string;
	sourcePath?: string;
	origin?: DrawerOrigin;
	/** Default 50, hard-capped by the vault at 500. */
	limit?: number;
	offset?: number;
}

/** A dated free-text note, filed per wing outside the room/drawer hierarchy. */
export interface DiaryEntry {
	id: string;
	wing: string;
	content: string;
	tags: string[];
	createdAt: IsoTimestamp;
}

export interface DiaryWriteInput {
	wing: string;
	content: string;
	tags?: readonly string[];
}

export interface DiaryReadOptions {
	wing?: string;
	/** Inclusive lower bound on `createdAt`. */
	since?: IsoTimestamp;
	limit?: number;
}

/** A drawer matched by FTS5, scored by BM25 (already sign-flipped so higher is better). */
export interface LexicalHit {
	drawerId: string;
	score: number;
	/** FTS5 `snippet()` output with match markers already stripped. */
	snippet: string;
}

export interface LexicalSearchOptions {
	wing?: string;
	room?: string;
	source?: string;
	limit?: number;
}

/** A drawer matched by cosine similarity against a stored vector. */
export interface VectorHit {
	drawerId: string;
	/** Cosine similarity in `[-1, 1]`; callers treat higher as better. */
	score: number;
}

export interface VectorSearchOptions {
	wing?: string;
	room?: string;
	model: string;
	limit?: number;
}

/** A drawer with no vector for the requested model yet. */
export interface PendingVectorRow {
	drawerId: string;
	text: string;
}

export interface VaultStats {
	wings: number;
	rooms: number;
	drawers: number;
	diaryEntries: number;
	vectors: number;
	/** On-disk size of the database file in bytes; `0` for in-memory vaults. */
	dbBytes: number;
	lastWriteAt?: IsoTimestamp;
}

export interface VaultOptions {
	/** Absolute path to the sqlite file, or `:memory:` for an ephemeral vault. */
	path: string;
	/** Create parent directories when missing. Default `true`. */
	createDirs?: boolean;
	/** Injected clock for deterministic tests. Defaults to `Date.now`. */
	now?: () => number;
}

/**
 * Storage surface. Implemented by `openVault` in `vault.ts`.
 *
 * Every method is synchronous — `bun:sqlite` is synchronous, and keeping the
 * storage layer free of promises makes the serving and ingest layers the only
 * places that can await.
 */
export interface Vault {
	/** The sqlite path this vault was opened with. */
	readonly path: string;

	listWings(): Wing[];
	listRooms(wing?: string): Room[];
	/** Idempotently create the wing and room rows. Returns the canonical room name. */
	ensureRoom(wing: string, room: string): string;

	addDrawer(input: DrawerInput): DrawerWriteResult;
	/** Batched `addDrawer`, wrapped in one transaction. Results align with `inputs` by index. */
	addDrawers(inputs: readonly DrawerInput[]): DrawerWriteResult[];
	getDrawer(id: string): Drawer | undefined;
	getDrawers(ids: readonly string[]): Drawer[];
	updateDrawer(id: string, patch: DrawerPatch): boolean;
	deleteDrawer(id: string): boolean;
	/** Delete every drawer whose `sourcePath` equals `sourcePath`. Returns the row count. */
	deleteBySource(sourcePath: string): number;
	listDrawers(filter?: DrawerFilter): Drawer[];
	/** Distinct non-null `sourcePath` values, used by the miner to prune vanished files. */
	knownSourcePaths(wing?: string): string[];

	/**
	 * Incremental-mining ledger backing Smart Mining. The miner reads this
	 * before touching a file: a `size` + `mtimeMs` match means the file is
	 * provably unchanged and is skipped without ever being opened, which turns
	 * a re-mine of a large tree from minutes of hashing and chunking into a
	 * stat walk.
	 */
	getMinedFiles(wing?: string): Map<string, MinedFileRecord>;
	recordMinedFile(record: MinedFileRecord): void;
	forgetMinedFile(path: string): void;

	searchLexical(query: string, options?: LexicalSearchOptions): LexicalHit[];

	/** Persist (or replace) the embedding for one drawer under a model id. */
	putVector(drawerId: string, model: string, vector: Float32Array | readonly number[]): void;
	/** Drawers lacking a vector for `model`, oldest first. */
	pendingVectors(model: string, limit: number): PendingVectorRow[];
	searchVector(query: Float32Array | readonly number[], options: VectorSearchOptions): VectorHit[];

	writeDiary(entry: DiaryWriteInput): DiaryEntry;
	readDiary(options?: DiaryReadOptions): DiaryEntry[];

	stats(): VaultStats;
	/** Drop every row in every table. Used by `/memory clear`. */
	wipe(): void;
	close(): void;
}

/** Factory exported by `vault.ts`. */
export type OpenVault = (options: VaultOptions) => Vault;

/** Which retrieval strategies a search may use. */
export type SearchMode = "lexical" | "vector" | "hybrid";

export interface SearchQuery {
	text: string;
	limit?: number;
	wing?: string;
	room?: string;
	source?: string;
	/** Default `hybrid`, which degrades to `lexical` when no embedder is available. */
	mode?: SearchMode;
	/** Drop hits whose fused score falls below this. Default `0`. */
	minScore?: number;
	signal?: AbortSignal;
}

export interface SearchHit {
	drawerId: string;
	wing: string;
	room: string;
	title: string;
	/** Best-effort excerpt around the match; falls back to a head slice of `content`. */
	snippet: string;
	/** Fused relevance score, higher is better. Not comparable across queries. */
	score: number;
	source?: string;
	sourcePath?: string;
	createdAt: IsoTimestamp;
	matchedBy: "lexical" | "vector" | "both";
}

export interface SearchResult {
	query: string;
	mode: SearchMode;
	/** The mode actually executed, which may be narrower than the requested one. */
	effectiveMode: SearchMode;
	hits: SearchHit[];
	/** Set when the requested mode was degraded, e.g. embeddings unavailable. */
	message?: string;
}

/**
 * Wake-up context: a cheap orientation payload injected into the system prompt.
 * `L0` is the palace shape, `L1` is the most relevant recent material.
 */
export interface WakeUpContext {
	/** One-line summary of palace size and the active wing. */
	headline: string;
	/** Wing/room inventory lines, already truncated to the caller's budget. */
	inventory: string[];
	/** Recent or salient drawer excerpts. */
	highlights: string[];
	/** Recent diary lines. */
	diary: string[];
	/** Rough token count of the rendered whole. */
	approxTokens: number;
}

export interface WakeUpOptions {
	wing?: string;
	/** Soft ceiling on the rendered size. Default 900. */
	tokenBudget?: number;
	signal?: AbortSignal;
}

/**
 * Embeds text into unit-normalized vectors. Returns one vector per input, in
 * order. Implementations MUST resolve to `null` — never throw — when the local
 * embeddings stack is unavailable, so search can degrade to lexical-only.
 */
export type EmbedFn = (texts: string[], signal?: AbortSignal) => Promise<number[][] | null>;

export interface SearcherOptions {
	/** Omit to run lexical-only. */
	embed?: EmbedFn;
	/** Model id recorded alongside stored vectors; vectors from other models are ignored. */
	embedModel?: string;
	/** How many lexical and vector candidates to fuse. Default 50 each. */
	candidateLimit?: number;
	/** Reciprocal-rank-fusion constant. Default 60. */
	rrfK?: number;
}

/** Serving surface. Implemented by `createSearcher` in `search.ts`. */
export interface Searcher {
	search(query: SearchQuery): Promise<SearchResult>;
	wakeUp(options?: WakeUpOptions): Promise<WakeUpContext>;
	/**
	 * Embed and store vectors for drawers that lack them. Returns how many were
	 * indexed. A no-op returning `0` when no embedder is configured.
	 */
	indexPending(limit?: number, signal?: AbortSignal): Promise<number>;
}

/** Factory exported by `search.ts`. */
export type CreateSearcher = (vault: Vault, options?: SearcherOptions) => Searcher;

/** How a mine run interprets its target directory. */
export type MineMode = "project" | "convos";

export interface MineOptions {
	/** Absolute directory to walk. */
	dir: string;
	wing: string;
	/**
	 * `project` chunks source and prose files. `convos` parses harness session
	 * transcripts into per-session drawers. Omit to auto-detect: a target at or
	 * under `sessionsDir` is mined as `convos`.
	 */
	mode?: MineMode;
	/** Harness session-log root used for `convos` auto-detection. */
	sessionsDir?: string;
	/** Skip files larger than this. Default 512 KiB. */
	maxFileBytes?: number;
	/** Stop after this many files. Default 2000. */
	maxFiles?: number;
	/**
	 * Re-read and re-chunk files the ledger says are unchanged. Default `false`
	 * — Smart Mining exists precisely so the common case never pays that cost.
	 */
	force?: boolean;
	/**
	 * Wall-clock ceiling for one run, in milliseconds. The run stops at the
	 * next file boundary once exceeded and reports `completed: false`; the
	 * scheduler resumes it on the next slice. Omit for no ceiling.
	 */
	budgetMillis?: number;
	signal?: AbortSignal;
}

/**
 * Cheap pre-flight: a stat-only walk that answers "is a mine worth running?"
 * without reading, hashing, or chunking a single file. Smart Mining calls this
 * before every scheduled run and skips entirely when `changedFiles` is zero.
 */
export interface MinePlan {
	mode: MineMode;
	/** Files that survived the ignore rules and extension allowlist. */
	candidateFiles: number;
	/** Candidates whose size or mtime differs from the ledger, so they need work. */
	changedFiles: number;
	/** Candidates the ledger already covers. */
	unchangedFiles: number;
	/** Total bytes of the changed set. */
	changedBytes: number;
	/** Rough cost estimate for the changed set, used for budgeting and warnings. */
	estimatedMillis: number;
	/** `true` when the walk hit `maxFiles` and the counts are a lower bound. */
	truncated: boolean;
}

export interface MineResult {
	mode: MineMode;
	filesScanned: number;
	filesSkipped: number;
	/** Candidates skipped because the ledger proved them unchanged. */
	filesUnchanged: number;
	drawersCreated: number;
	drawersUpdated: number;
	/** `false` when the run stopped on `budgetMillis`, `maxFiles`, or an abort. */
	completed: boolean;
	/** Wall-clock duration of the run. */
	elapsedMillis: number;
	/** Non-fatal per-file problems, capped at 20 entries. */
	warnings: string[];
}

/**
 * Everything the mine worker needs to walk a tree. Deliberately a plain data
 * object: it crosses an IPC boundary, so it carries no functions, no signals,
 * and no vault handle.
 */
export interface MineWorkerPlanRequest {
	dir: string;
	mode: MineMode;
	maxFileBytes: number;
	maxFiles: number;
	/**
	 * The ledger, flattened for transport: absolute path → `size:mtimeMs`.
	 * The worker treats a hit as unchanged and skips it unless `force` is set.
	 */
	ledger: Record<string, string>;
	force: boolean;
}

export interface MineWorkerRunRequest extends MineWorkerPlanRequest {
	/** Stop walking once this much wall-clock has elapsed in the child. `0` disables. */
	budgetMillis: number;
}

/** One fully processed file, streamed from the worker to the parent. */
export interface MinedFilePayload {
	path: string;
	size: number;
	mtimeMs: number;
	contentHash: string;
	/** Directory of the file relative to the mine root; `root` at the top level. */
	room: string;
	chunks: { title: string; body: string }[];
}

/** Terminal counters reported by the worker when a run ends. */
export interface MineRunSummary {
	filesScanned: number;
	filesSkipped: number;
	filesUnchanged: number;
	completed: boolean;
	warnings: string[];
}

export interface SyncOptions {
	wing?: string;
	/** Absolute directory whose gitignore rules apply. Defaults to the vault's cwd. */
	dir?: string;
	signal?: AbortSignal;
}

export interface SyncResult {
	checked: number;
	/** Drawers dropped because their source file vanished or became ignored. */
	pruned: number;
}

export interface MinerOptions {
	/** Absolute path used to resolve relative mine targets. */
	cwd: string;
	/** Harness session-log root, injected so tests can stub the boundary. */
	sessionsDir?: () => string | undefined;
	/**
	 * Override the mine worker. Production passes nothing and gets the real
	 * subprocess; tests pass an in-process fake so no child is spawned.
	 */
	spawnWorker?: () => MineWorkerHandle;
}

/**
 * Parent-side handle for the mine subprocess. The walk, the reads, the hashing
 * and the chunking all run in the child, because every one of those is
 * synchronous and would otherwise block the agent's event loop for the whole
 * duration of a mine. The parent only diffs the ledger and writes drawers.
 */
export interface MineWorkerHandle {
	/** Stat-only pre-flight. Resolves to `null` when the worker is unavailable. */
	plan(request: MineWorkerPlanRequest): Promise<MinePlan | null>;
	/**
	 * Stream mined files back as they are produced. `onFile` is awaited, so the
	 * parent's vault writes apply backpressure to the child's walk.
	 */
	run(
		request: MineWorkerRunRequest,
		onFile: (file: MinedFilePayload) => Promise<void> | void,
	): Promise<MineRunSummary>;
	dispose(): void;
}

/** Ingest surface. Implemented by `createMiner` in `miner.ts`. */
export interface Miner {
	/** Stat-only cost estimate. Never reads file contents. */
	plan(options: MineOptions): Promise<MinePlan>;
	mine(options: MineOptions): Promise<MineResult>;
	sync(options?: SyncOptions): Promise<SyncResult>;
	/** Release the worker subprocess, if one was spawned. */
	dispose(): void;
}

/** Factory exported by `miner.ts`. */
export type CreateMiner = (vault: Vault, options: MinerOptions) => Miner;

/** One row of the incremental-mining ledger. */
export interface MinedFileRecord {
	/** Absolute file path; the primary key. */
	path: string;
	wing: string;
	size: number;
	mtimeMs: number;
	/** SHA-256 of the file contents, used to confirm a suspected change. */
	contentHash: string;
	minedAt: IsoTimestamp;
	/** How many drawers this file produced on its last mine. */
	drawerCount: number;
}

/** What triggered a Smart Mining evaluation. */
export type MineTrigger = "startup" | "idle" | "cadence" | "manual";

/** The scheduler's verdict on whether to spend cycles right now. */
export interface MineDecision {
	run: boolean;
	/** Human-readable justification, surfaced by `status` and the tool. */
	reason: string;
	trigger: MineTrigger;
	/** Present when the decision required a pre-flight walk. */
	plan?: MinePlan;
}

export interface MineSchedulerState {
	/** `true` while a mine slice is in flight. */
	running: boolean;
	/** Substantive user turns observed since the last completed mine. */
	turnsSinceMine: number;
	/** Consecutive evaluations that found nothing to do; drives the backoff. */
	idleStreak: number;
	lastRunAt?: IsoTimestamp;
	lastResult?: MineResult;
	lastDecision?: MineDecision;
	/** Set when a run stopped on its budget and has work left to resume. */
	resumePending: boolean;
}

export interface MineSchedulerOptions {
	/** Directory to mine, and the wing it maps to. */
	dir: string;
	wing: string;
	/** Run automatically at all. Default `false`. */
	autoIngest: boolean;
	/** Substantive user turns between cadence evaluations. Default 15, min 1. */
	ingestIntervalMessages: number;
	/** Wall-clock ceiling per slice. Default 4000. */
	budgetMillis?: number;
	/** Quiet period after a turn ends before an idle mine may start. Default 2000. */
	idleDelayMillis?: number;
	/** Floor between two runs regardless of trigger. Default 60000. */
	minIntervalMillis?: number;
	/**
	 * Refuse to auto-run when the pre-flight estimates more work than this,
	 * and report it instead so the user can mine explicitly. Default 120000.
	 */
	maxAutoEstimatedMillis?: number;
	/** Injected clock for deterministic tests. Defaults to `Date.now`. */
	now?: () => number;
	/** Injected timer, so tests need no real delays. Defaults to `setTimeout`. */
	schedule?: (fn: () => void, delayMillis: number) => { cancel(): void };
}

/**
 * Smart Mining. Mining is process-intensive, so nothing mines on a whim: the
 * scheduler decides *whether* to mine from turn cadence, an idle window, a
 * backoff on fruitless runs, and a stat-only pre-flight, then runs the work in
 * bounded slices that abort the moment the user starts a new turn.
 */
export interface MineScheduler {
	/** Record a substantive user turn. Cancels any in-flight idle mine. */
	noteUserTurn(): void;
	/** Record the end of an agent turn; arms the idle window. */
	noteTurnEnd(): void;
	/** Evaluate without running. Cheap for every trigger except a pre-flight. */
	shouldMine(trigger: MineTrigger): Promise<MineDecision>;
	/** Evaluate, then run one bounded slice when the verdict says so. */
	requestMine(trigger: MineTrigger): Promise<MineResult | null>;
	/** Abort any in-flight slice and disarm the idle timer. */
	cancel(): void;
	state(): MineSchedulerState;
	dispose(): void;
}

/** Factory exported by `scheduler.ts`. */
export type CreateMineScheduler = (
	miner: Miner,
	searcher: Searcher | undefined,
	options: MineSchedulerOptions,
) => MineScheduler;

/**
 * Normalize a project directory basename into a wing name: lowercased, every
 * character outside `[a-z0-9_]` collapsed to `_`, leading and trailing
 * underscores stripped, falling back to `workspace` when nothing survives.
 *
 * Implemented in `vault.ts` and re-exported from the barrel; the miner, the
 * backend, and the tool all derive wings through it so a project maps to one
 * wing no matter which surface wrote first.
 */
export type WingNameFor = (projectDir: string) => string;

/**
 * The per-session palace surface the builtin `mempalace` tool drives.
 *
 * Declared here, rather than as the concrete class in `backend.ts`, so that
 * `state.ts` — and therefore `tools/index.ts` and `session/agent-session.ts` —
 * can reference it without pulling the vault, the miner, the searcher and the
 * scheduler into the CLI startup module graph. `backend.ts` stays lazy-loaded
 * behind `resolveMemoryBackend`, exactly like every sibling backend.
 */
export interface MempalaceNativeSession {
	readonly wing: string;
	search(query: SearchQuery): Promise<SearchResult>;
	save(input: DrawerInput): DrawerWriteResult;
	getDrawer(id: string): Drawer | undefined;
	listWings(): Wing[];
	listRooms(wing?: string): Room[];
	listDrawers(filter?: DrawerFilter): Drawer[];
	writeDiary(entry: DiaryWriteInput): DiaryEntry;
	readDiary(options?: DiaryReadOptions): DiaryEntry[];
	/** Stat-only pre-flight, for the tool's `mine` dry run. */
	planMine(options: MineOptions): Promise<MinePlan>;
	mine(options: MineOptions): Promise<MineResult>;
	sync(options?: SyncOptions): Promise<SyncResult>;
	stats(): VaultStats;
	/** `undefined` in a subagent, which never gets a scheduler. */
	schedulerState(): MineSchedulerState | undefined;
	/** Whether the vector leg is actually available this session. */
	embeddingsActive(): boolean;
	/** Release resources, unregister turn listeners and close SQLite vault. */
	dispose(): void;
}
