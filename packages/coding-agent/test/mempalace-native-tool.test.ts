/**
 * Behavioural tests for the agent-facing `mempalace` tool.
 *
 * The tool owns dispatch, defaulting, and rendering; storage, embedding, and
 * mining live behind `MempalaceNativeSession`. So the collaborator here is a
 * hand-rolled fake typed to that interface — no vault, no worker subprocess, no
 * backend boot, no filesystem. Typing the fake to the real interface is what
 * makes these tests prove the contract rather than a convenient shape.
 */
import { describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MemoryBackendId } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import type {
	DiaryEntry,
	DiaryReadOptions,
	DiaryWriteInput,
	Drawer,
	DrawerFilter,
	DrawerInput,
	DrawerWriteResult,
	MempalaceNativeSession,
	MineOptions,
	MinePlan,
	MineResult,
	MineSchedulerState,
	Room,
	SearchHit,
	SearchQuery,
	SearchResult,
	SyncOptions,
	SyncResult,
	VaultStats,
	Wing,
} from "@oh-my-pi/pi-coding-agent/mempalace-native/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type MempalaceParams, MempalaceTool } from "@oh-my-pi/pi-coding-agent/tools/mempalace";

const SESSION_WING = "session_wing";
const STAMP = "2026-08-12T00:00:00.000Z";

/** Every `memory.backend` value that must NOT expose the tool. */
const OTHER_BACKENDS: MemoryBackendId[] = ["off", "local", "hindsight", "mnemopi", "mempalace"];

function drawer(overrides: Partial<Drawer> = {}): Drawer {
	return {
		id: "d1",
		wing: SESSION_WING,
		room: "notes",
		title: "A drawer",
		content: "Drawer body",
		origin: "manual",
		addedBy: "omp",
		tags: [],
		contentHash: "hash-1",
		createdAt: STAMP,
		updatedAt: STAMP,
		...overrides,
	};
}

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
	return {
		drawerId: "d1",
		wing: SESSION_WING,
		room: "notes",
		title: "A drawer",
		snippet: "matched snippet",
		score: 0.5,
		createdAt: STAMP,
		matchedBy: "lexical",
		...overrides,
	};
}

function searchResult(hits: SearchHit[], overrides: Partial<SearchResult> = {}): SearchResult {
	return { query: "q", mode: "hybrid", effectiveMode: "hybrid", hits, ...overrides };
}

function minePlan(overrides: Partial<MinePlan> = {}): MinePlan {
	return {
		mode: "project",
		candidateFiles: 10,
		changedFiles: 4,
		unchangedFiles: 6,
		changedBytes: 2048,
		estimatedMillis: 1500,
		truncated: false,
		...overrides,
	};
}

function mineResult(overrides: Partial<MineResult> = {}): MineResult {
	return {
		mode: "project",
		filesScanned: 4,
		filesSkipped: 1,
		filesUnchanged: 6,
		drawersCreated: 7,
		drawersUpdated: 2,
		completed: true,
		elapsedMillis: 1234,
		warnings: [],
		...overrides,
	};
}

function vaultStats(overrides: Partial<VaultStats> = {}): VaultStats {
	return { wings: 2, rooms: 5, drawers: 40, diaryEntries: 3, vectors: 40, dbBytes: 4096, ...overrides };
}

function schedulerState(overrides: Partial<MineSchedulerState> = {}): MineSchedulerState {
	return { running: false, turnsSinceMine: 3, idleStreak: 1, resumePending: false, ...overrides };
}

/** Every call the tool made, so dispatch and argument shaping can be asserted. */
interface Calls {
	search: SearchQuery[];
	save: DrawerInput[];
	getDrawer: string[];
	listWings: number;
	listRooms: (string | undefined)[];
	listDrawers: (DrawerFilter | undefined)[];
	writeDiary: DiaryWriteInput[];
	readDiary: (DiaryReadOptions | undefined)[];
	planMine: MineOptions[];
	mine: MineOptions[];
	sync: (SyncOptions | undefined)[];
	stats: number;
	schedulerState: number;
	embeddingsActive: number;
}

interface Stubs {
	wing?: string;
	search?: SearchResult;
	save?: DrawerWriteResult;
	/** A function, so a test can return `undefined` for a miss. */
	getDrawer?: (id: string) => Drawer | undefined;
	listWings?: Wing[];
	listRooms?: Room[];
	listDrawers?: Drawer[];
	writeDiary?: DiaryEntry;
	readDiary?: DiaryEntry[];
	planMine?: MinePlan;
	mine?: MineResult;
	sync?: SyncResult;
	stats?: VaultStats;
	/** A function, so a subagent test can return `undefined`. */
	schedulerState?: () => MineSchedulerState | undefined;
	embeddingsActive?: boolean;
}

function createState(stubs: Stubs = {}): { state: MempalaceNativeSession; calls: Calls } {
	const calls: Calls = {
		search: [],
		save: [],
		getDrawer: [],
		listWings: 0,
		listRooms: [],
		listDrawers: [],
		writeDiary: [],
		readDiary: [],
		planMine: [],
		mine: [],
		sync: [],
		stats: 0,
		schedulerState: 0,
		embeddingsActive: 0,
	};
	const state: MempalaceNativeSession = {
		wing: stubs.wing ?? SESSION_WING,
		async search(query) {
			calls.search.push(query);
			return stubs.search ?? searchResult([hit()]);
		},
		save(input) {
			calls.save.push(input);
			return stubs.save ?? { id: "d1", created: true, updated: false };
		},
		getDrawer(id) {
			calls.getDrawer.push(id);
			return stubs.getDrawer ? stubs.getDrawer(id) : drawer({ id });
		},
		listWings() {
			calls.listWings += 1;
			return stubs.listWings ?? [{ name: SESSION_WING, roomCount: 2, drawerCount: 9, updatedAt: STAMP }];
		},
		listRooms(wing) {
			calls.listRooms.push(wing);
			return stubs.listRooms ?? [{ wing: wing ?? SESSION_WING, name: "notes", drawerCount: 4, updatedAt: STAMP }];
		},
		listDrawers(filter) {
			calls.listDrawers.push(filter);
			return stubs.listDrawers ?? [drawer()];
		},
		writeDiary(entry) {
			calls.writeDiary.push(entry);
			return (
				stubs.writeDiary ?? {
					id: "e1",
					wing: entry.wing,
					content: entry.content,
					tags: [...(entry.tags ?? [])],
					createdAt: STAMP,
				}
			);
		},
		readDiary(options) {
			calls.readDiary.push(options);
			return (
				stubs.readDiary ?? [{ id: "e1", wing: SESSION_WING, content: "diary body", tags: [], createdAt: STAMP }]
			);
		},
		async planMine(options) {
			calls.planMine.push(options);
			return stubs.planMine ?? minePlan();
		},
		async mine(options) {
			calls.mine.push(options);
			return stubs.mine ?? mineResult();
		},
		async sync(options) {
			calls.sync.push(options);
			return stubs.sync ?? { checked: 12, pruned: 2 };
		},
		stats() {
			calls.stats += 1;
			return stubs.stats ?? vaultStats();
		},
		schedulerState() {
			calls.schedulerState += 1;
			return stubs.schedulerState ? stubs.schedulerState() : schedulerState();
		},
		embeddingsActive() {
			calls.embeddingsActive += 1;
			return stubs.embeddingsActive ?? true;
		},
		dispose() {
			// No-op mock
		},
	};
	return { state, calls };
}

function createSession(backend: MemoryBackendId, state?: MempalaceNativeSession): ToolSession {
	const session: ToolSession = {
		cwd: "/tmp/mempalace-native-tool-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "memory.backend": backend }),
	};
	if (state) session.getMempalaceNativeSessionState = () => state;
	return session;
}

function harness(stubs: Stubs = {}): { tool: MempalaceTool; calls: Calls } {
	const { state, calls } = createState(stubs);
	return { tool: new MempalaceTool(createSession("mempalace-native", state)), calls };
}

function textOf(result: AgentToolResult): string {
	const [first] = result.content;
	return first && first.type === "text" ? first.text : "";
}

function run(tool: MempalaceTool, params: MempalaceParams, signal?: AbortSignal): Promise<AgentToolResult> {
	return tool.execute("call-1", params, signal);
}

describe("MempalaceTool.createIf", () => {
	for (const backend of OTHER_BACKENDS) {
		it(`returns null for memory.backend "${backend}"`, () => {
			expect(MempalaceTool.createIf(createSession(backend))).toBeNull();
		});
	}

	it("returns an instance for memory.backend mempalace-native", () => {
		const tool = MempalaceTool.createIf(createSession("mempalace-native"));
		expect(tool).toBeInstanceOf(MempalaceTool);
		expect(tool?.name).toBe("mempalace");
		expect(tool?.approval()).toBe("read");
	});
});

describe("MempalaceTool session state", () => {
	it("throws the initialisation error when the tool session exposes no hook", async () => {
		const tool = new MempalaceTool(createSession("mempalace-native"));
		await expect(run(tool, { action: "status" })).rejects.toThrow(
			"MemPalace native backend is not initialised for this session.",
		);
	});

	it("throws the initialisation error when the hook returns undefined", async () => {
		const session = createSession("mempalace-native");
		session.getMempalaceNativeSessionState = () => undefined;
		await expect(run(new MempalaceTool(session), { action: "status" })).rejects.toThrow(
			"MemPalace native backend is not initialised for this session.",
		);
	});
});

describe("MempalaceTool required fields", () => {
	const cases: { action: MempalaceParams["action"]; field: string }[] = [
		{ action: "search", field: "query" },
		{ action: "save", field: "content" },
		{ action: "get", field: "id" },
		{ action: "mine", field: "dir" },
	];

	for (const { action, field } of cases) {
		it(`${action} throws a message naming \`${field}\` when it is absent`, async () => {
			const { tool } = harness();
			const error = await run(tool, { action }).catch((err: unknown) => err);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(`\`${field}\``);
			expect((error as Error).message).toContain(`\`mempalace ${action}\``);
		});

		it(`${action} treats a whitespace-only \`${field}\` as absent`, async () => {
			const { tool } = harness();
			await expect(run(tool, { action, [field]: "   " } as MempalaceParams)).rejects.toThrow(`\`${field}\``);
		});
	}
});

describe("MempalaceTool search", () => {
	it("forwards the trimmed query, scope, and limit", async () => {
		const { tool, calls } = harness();
		const result = await run(tool, { action: "search", query: "  needle  ", wing: "w", room: "r", limit: 3 });
		expect(calls.search).toHaveLength(1);
		expect(calls.search[0]).toMatchObject({ text: "needle", wing: "w", room: "r", limit: 3 });
		expect(textOf(result)).toContain(`${SESSION_WING}/notes · A drawer`);
	});

	it("forwards the abort signal", async () => {
		const { tool, calls } = harness();
		const controller = new AbortController();
		await run(tool, { action: "search", query: "needle" }, controller.signal);
		expect(calls.search[0]?.signal).toBe(controller.signal);
	});

	it("renders numbered hits with ids and snippets", async () => {
		const { tool } = harness({
			search: searchResult([
				hit({ drawerId: "a1", title: "First", snippet: "alpha" }),
				hit({ drawerId: "b2", title: "Second", room: "docs", snippet: "beta", matchedBy: "both" }),
			]),
		});
		const text = textOf(await run(tool, { action: "search", query: "needle" }));
		expect(text).toContain("Found 2 drawers");
		expect(text).toContain("1. session_wing/notes · First");
		expect(text).toContain("id: a1");
		expect(text).toContain("alpha");
		expect(text).toContain("2. session_wing/docs · Second");
		expect(text).toContain("matched both");
	});

	it("renders a clear empty-result string rather than an empty body", async () => {
		const { tool } = harness({ search: searchResult([]) });
		const result = await run(tool, { action: "search", query: "ghost" });
		const text = textOf(result);
		expect(text.trim()).not.toBe("");
		expect(text).toContain('No drawers matched "ghost"');
		expect(text).toContain("mempalace list");
		expect(result.useless).toBe(true);
	});

	it("names the scope in the empty-result string and surfaces a degradation note", async () => {
		const { tool } = harness({
			search: searchResult([], { effectiveMode: "lexical", message: "Embeddings unavailable; lexical only." }),
		});
		const text = textOf(await run(tool, { action: "search", query: "ghost", wing: "w", room: "r" }));
		expect(text).toContain("in w/r");
		expect(text).toContain("Embeddings unavailable; lexical only.");
	});
});

describe("MempalaceTool save", () => {
	it("defaults wing, room, and title, and stamps provenance", async () => {
		const { tool, calls } = harness();
		const result = await run(tool, { action: "save", content: "Remember this\nand more" });
		expect(calls.save).toHaveLength(1);
		expect(calls.save[0]).toMatchObject({
			wing: SESSION_WING,
			room: "notes",
			title: "Remember this",
			content: "Remember this\nand more",
			origin: "manual",
			source: "mempalace",
		});
		expect(textOf(result)).toContain("Filed drawer d1");
	});

	it("honours an explicit wing, room, title, and tags", async () => {
		const { tool, calls } = harness();
		await run(tool, {
			action: "save",
			content: "Body",
			wing: "other",
			room: "decisions",
			title: "Chose bun:sqlite",
			tags: ["adr", "storage"],
		});
		expect(calls.save[0]).toMatchObject({
			wing: "other",
			room: "decisions",
			title: "Chose bun:sqlite",
			tags: ["adr", "storage"],
		});
	});

	it("reports where the drawer actually landed, not where it was aimed", async () => {
		const { tool } = harness({ getDrawer: id => drawer({ id, wing: "canonical", room: "inbox" }) });
		const text = textOf(await run(tool, { action: "save", content: "Body", wing: "requested" }));
		expect(text).toContain("canonical/inbox");
	});

	it("reports a duplicate instead of claiming a write", async () => {
		const { tool } = harness({ save: { id: "d9", created: false, updated: false } });
		const text = textOf(await run(tool, { action: "save", content: "Body" }));
		expect(text).toContain("already filed as d9");
		expect(text).toContain("nothing changed");
	});

	it("reports an in-place refresh of a duplicate", async () => {
		const { tool } = harness({ save: { id: "d9", created: false, updated: true } });
		expect(textOf(await run(tool, { action: "save", content: "Body" }))).toContain("refreshed");
	});

	it("reports a failed write instead of a phantom duplicate when the id is empty", async () => {
		// The vault's non-throwing failure sentinel is a zeroed result, which is
		// byte-for-byte what a duplicate looks like. Reporting "already filed"
		// here would tell the model its note is safe when nothing was stored.
		const { tool, calls } = harness({ save: { id: "", created: false, updated: false } });
		const text = textOf(await run(tool, { action: "save", content: "Body", wing: "w", room: "r" }));
		expect(text).toContain("could not file the drawer into w/r");
		expect(text).toContain("Nothing was stored");
		expect(text).not.toContain("already filed");
		expect(calls.getDrawer).toHaveLength(0);
	});
});

describe("MempalaceTool get", () => {
	it("looks the drawer up by id and renders it in full", async () => {
		const { tool, calls } = harness({
			getDrawer: id => drawer({ id, tags: ["a", "b"], source: "mempalace", content: "Full body text" }),
		});
		const text = textOf(await run(tool, { action: "get", id: "  d7  " }));
		expect(calls.getDrawer).toEqual(["d7"]);
		expect(text).toContain("id: d7");
		expect(text).toContain("tags: a, b");
		expect(text).toContain("Full body text");
	});

	it("reports a miss without throwing", async () => {
		const { tool } = harness({ getDrawer: () => undefined });
		const result = await run(tool, { action: "get", id: "nope" });
		expect(textOf(result)).toContain("No drawer with id nope");
		expect(result.useless).toBe(true);
	});
});

describe("MempalaceTool list", () => {
	it("lists wings when no wing is given", async () => {
		const { tool, calls } = harness();
		const text = textOf(await run(tool, { action: "list" }));
		expect(calls.listWings).toBe(1);
		expect(calls.listRooms).toHaveLength(0);
		expect(calls.listDrawers).toHaveLength(0);
		expect(text).toContain(SESSION_WING);
		expect(text).toContain("2 rooms");
	});

	it("lists that wing's rooms when only a wing is given", async () => {
		const { tool, calls } = harness();
		const text = textOf(await run(tool, { action: "list", wing: "w" }));
		expect(calls.listRooms).toEqual(["w"]);
		expect(calls.listWings).toBe(0);
		expect(calls.listDrawers).toHaveLength(0);
		expect(text).toContain("w/notes");
	});

	it("lists drawers when both wing and room are given", async () => {
		const { tool, calls } = harness();
		const text = textOf(await run(tool, { action: "list", wing: "w", room: "r", limit: 5 }));
		expect(calls.listDrawers).toEqual([{ wing: "w", room: "r", limit: 5 }]);
		expect(calls.listWings).toBe(0);
		expect(calls.listRooms).toHaveLength(0);
		expect(text).toContain("1. A drawer");
		expect(text).toContain("id: d1");
	});

	it("reports an empty palace as prose", async () => {
		const { tool } = harness({ listWings: [] });
		const result = await run(tool, { action: "list" });
		expect(textOf(result)).toContain("The palace is empty");
		expect(result.useless).toBe(true);
	});
});

describe("MempalaceTool diary", () => {
	it("writes an entry when content is supplied, defaulting the wing", async () => {
		const { tool, calls } = harness();
		const text = textOf(await run(tool, { action: "diary", content: "Shipped the vault", tags: ["log"] }));
		expect(calls.writeDiary).toEqual([{ wing: SESSION_WING, content: "Shipped the vault", tags: ["log"] }]);
		expect(calls.readDiary).toHaveLength(0);
		expect(text).toContain("Wrote diary entry e1");
	});

	it("writes to an explicit wing", async () => {
		const { tool, calls } = harness();
		await run(tool, { action: "diary", content: "Note", wing: "other" });
		expect(calls.writeDiary[0]).toMatchObject({ wing: "other" });
	});

	it("reads recent entries when no content is supplied", async () => {
		const { tool, calls } = harness();
		const text = textOf(await run(tool, { action: "diary", limit: 4 }));
		expect(calls.readDiary).toEqual([{ wing: undefined, limit: 4 }]);
		expect(calls.writeDiary).toHaveLength(0);
		expect(text).toContain("diary body");
	});

	it("reads a single wing when one is named", async () => {
		const { tool, calls } = harness();
		await run(tool, { action: "diary", wing: "w" });
		expect(calls.readDiary[0]).toMatchObject({ wing: "w" });
	});

	it("reports an empty diary as prose", async () => {
		const { tool } = harness({ readDiary: [] });
		const result = await run(tool, { action: "diary" });
		expect(textOf(result)).toContain("No diary entries");
		expect(result.useless).toBe(true);
	});

	it("reports a failed diary write instead of claiming success", async () => {
		const { tool } = harness({
			writeDiary: { id: "", wing: SESSION_WING, content: "Note", tags: [], createdAt: STAMP },
		});
		const text = textOf(await run(tool, { action: "diary", content: "Note" }));
		expect(text).toContain("could not write the diary entry");
		expect(text).toContain("Nothing was stored");
		expect(text).not.toContain("Wrote diary entry");
	});
});

describe("MempalaceTool mine", () => {
	it("with plan:true calls the planning path and never the mining path", async () => {
		const { tool, calls } = harness();
		const text = textOf(await run(tool, { action: "mine", dir: "/tmp/project", plan: true }));
		expect(calls.planMine).toHaveLength(1);
		expect(calls.mine).toHaveLength(0);
		expect(calls.planMine[0]).toMatchObject({ dir: "/tmp/project", wing: SESSION_WING, force: false });
		expect(text).toContain("dry run");
		expect(text).toContain("candidate files");
		expect(text).toContain("changed");
		expect(text).toContain("unchanged");
		expect(text).toContain("estimated cost");
	});

	it("without plan calls the mining path and never the planning path", async () => {
		const { tool, calls } = harness();
		const text = textOf(await run(tool, { action: "mine", dir: "/tmp/project" }));
		expect(calls.mine).toHaveLength(1);
		expect(calls.planMine).toHaveLength(0);
		expect(calls.mine[0]).toMatchObject({ dir: "/tmp/project", wing: SESSION_WING, force: false });
		expect(text).toContain("drawers created");
		expect(text).toContain("Run completed.");
	});

	it("treats plan:false as a real mine", async () => {
		const { tool, calls } = harness();
		await run(tool, { action: "mine", dir: "/tmp/project", plan: false });
		expect(calls.mine).toHaveLength(1);
		expect(calls.planMine).toHaveLength(0);
	});

	it("forwards force on the planning path", async () => {
		const { tool, calls } = harness();
		const text = textOf(await run(tool, { action: "mine", dir: "/tmp/project", plan: true, force: true }));
		expect(calls.planMine[0]?.force).toBe(true);
		expect(text).toContain("`force` is set");
	});

	it("forwards force on the mining path", async () => {
		const { tool, calls } = harness();
		const text = textOf(await run(tool, { action: "mine", dir: "/tmp/project", force: true }));
		expect(calls.mine[0]?.force).toBe(true);
		expect(text).toContain("`force` was set");
	});

	it("forwards an explicit wing and the abort signal", async () => {
		const { tool, calls } = harness();
		const controller = new AbortController();
		await run(tool, { action: "mine", dir: "/tmp/project", wing: "other" }, controller.signal);
		expect(calls.mine[0]).toMatchObject({ wing: "other" });
		expect(calls.mine[0]?.signal).toBe(controller.signal);
	});

	it("says there is nothing to do when the plan finds no changes", async () => {
		const { tool } = harness({ planMine: minePlan({ changedFiles: 0, unchangedFiles: 10, changedBytes: 0 }) });
		expect(textOf(await run(tool, { action: "mine", dir: "/tmp/project", plan: true }))).toContain("Nothing to do");
	});

	it("flags a truncated plan as a lower bound", async () => {
		const { tool } = harness({ planMine: minePlan({ truncated: true }) });
		expect(textOf(await run(tool, { action: "mine", dir: "/tmp/project", plan: true }))).toContain("lower bound");
	});

	it("reports a clean budget stop as the normal sliced path, not a fault", async () => {
		const { tool } = harness({ mine: mineResult({ completed: false, warnings: [] }) });
		const text = textOf(await run(tool, { action: "mine", dir: "/tmp/project" }));
		expect(text).toContain("normal sliced path");
		expect(text).toContain("scheduler resumes it on the next slice");
		expect(text).not.toContain("reported problems");
	});

	it("reports a run that did not finish with problems, and lists them", async () => {
		const { tool } = harness({ mine: mineResult({ completed: false, warnings: ["unreadable: a.bin"] }) });
		const text = textOf(await run(tool, { action: "mine", dir: "/tmp/project" }));
		expect(text).toContain("reported problems");
		expect(text).toContain("unreadable: a.bin");
		expect(text).not.toContain("normal sliced path");
	});
});

describe("MempalaceTool sync", () => {
	it("forwards wing, dir, and signal, and reports the counts", async () => {
		const { tool, calls } = harness();
		const controller = new AbortController();
		const text = textOf(await run(tool, { action: "sync", wing: "w", dir: "/tmp/project" }, controller.signal));
		expect(calls.sync).toHaveLength(1);
		expect(calls.sync[0]).toMatchObject({ wing: "w", dir: "/tmp/project", signal: controller.signal });
		expect(text).toContain("checked 12 sources");
		expect(text).toContain("pruned 2 drawers");
	});

	it("leaves wing and dir unset when not supplied", async () => {
		const { tool, calls } = harness();
		await run(tool, { action: "sync" });
		expect(calls.sync[0]).toMatchObject({ wing: undefined, dir: undefined });
	});

	it("singularises a one-drawer prune", async () => {
		const { tool } = harness({ sync: { checked: 1, pruned: 1 } });
		const text = textOf(await run(tool, { action: "sync" }));
		expect(text).toContain("checked 1 source,");
		expect(text).toContain("pruned 1 drawer.");
	});
});

describe("MempalaceTool status", () => {
	it("reports palace stats, active embeddings, and scheduler state", async () => {
		const { tool, calls } = harness({
			schedulerState: () => schedulerState({ running: true, resumePending: true, lastRunAt: STAMP }),
		});
		const text = textOf(await run(tool, { action: "status" }));
		expect(calls.stats).toBe(1);
		expect(calls.embeddingsActive).toBe(1);
		expect(calls.schedulerState).toBe(1);
		expect(text).toContain("Palace");
		expect(text).toContain("drawers");
		expect(text).toContain("Embeddings: active");
		expect(text).toContain("Smart Mining");
		expect(text).toContain("a mine slice is in flight");
		expect(text).toContain("truncated run has work left");
	});

	it("reports lexical-only search when embeddings are inactive", async () => {
		const { tool } = harness({ embeddingsActive: false });
		expect(textOf(await run(tool, { action: "status" }))).toContain("Embeddings: inactive");
	});

	it("renders the no-scheduler case instead of crashing in a subagent", async () => {
		const { tool } = harness({ schedulerState: () => undefined });
		const text = textOf(await run(tool, { action: "status" }));
		expect(text).toContain("no scheduler in this session");
		expect(text).toContain("Palace");
	});

	it("surfaces the most recent scheduler decision", async () => {
		const { tool } = harness({
			schedulerState: () =>
				schedulerState({
					lastDecision: { run: false, reason: "estimate exceeds the auto ceiling", trigger: "cadence" },
				}),
		});
		expect(textOf(await run(tool, { action: "status" }))).toContain("estimate exceeds the auto ceiling");
	});
});

describe("MempalaceTool cancellation", () => {
	it("rejects without touching the palace when the signal is already aborted", async () => {
		const { tool, calls } = harness();
		const controller = new AbortController();
		controller.abort();
		await expect(run(tool, { action: "status" }, controller.signal)).rejects.toThrow();
		expect(calls.stats).toBe(0);
	});
});
