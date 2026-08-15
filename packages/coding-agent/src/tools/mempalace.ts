import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { formatBytes, logger, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "@oh-my-pi/omptype";
import type {
	Drawer,
	MempalaceNativeSession,
	MineOptions,
	MinePlan,
	MineResult,
	MineSchedulerState,
	SearchResult,
	VaultStats,
} from "../mempalace-native/types";
import desc from "../prompts/tools/mempalace.md" with { type: "text" };
import type { ToolSession } from ".";

/** Room a save lands in when the caller names none. */
const DEFAULT_ROOM = "notes";

/** Longest title derived from content when the caller supplies none. */
const DERIVED_TITLE_MAX = 72;

/** Provenance stamped on drawers written through this tool. */
const TOOL_SOURCE = "mempalace";

const schema = type({
	action: type("'search' | 'save' | 'get' | 'list' | 'diary' | 'mine' | 'sync' | 'status'").describe(
		"which palace operation to run",
	),
	"query?": type("string").describe("search text; required for `search`"),
	"content?": type("string").describe(
		"drawer body for `save`; for `diary`, its presence writes an entry instead of reading",
	),
	"id?": type("string").describe("drawer id, as returned by `search` and `list`; required for `get`"),
	"wing?": type("string").describe("project partition; defaults to this session's wing"),
	"room?": type("string").describe("room within the wing; defaults to `notes` on save"),
	"title?": type("string").describe("drawer title for `save`; derived from the content when omitted"),
	"dir?": type("string").describe("directory to walk; required for `mine`, and narrows `sync` to one tree"),
	"limit?": type("number").describe("maximum results for `search`, `list`, and `diary` reads"),
	"tags?": type("string[]").describe("free-form labels applied by `save` and `diary` writes"),
	"plan?": type("boolean").describe("`mine` only: run the stat-only pre-flight and file nothing"),
	"force?": type("boolean").describe("`mine` only: re-read files the ledger proves unchanged"),
});

export type MempalaceParams = typeof schema.infer;

/**
 * Agent-facing surface over the native (pure TypeScript) MemPalace store.
 *
 * The tool owns presentation and defaulting only. Storage, embedding, mining,
 * and scheduling live behind {@link MempalaceNativeSession}, whose methods
 * absorb their own dependency failures and hand back safe values — an empty
 * hit list, a zeroed result, `undefined` for a scheduler a subagent never had.
 * Degradation is therefore a rendering concern here, not a `catch`: an
 * unexpected throw is a real fault, so it is logged and re-raised rather than
 * dressed up as a successful result.
 */
export class MempalaceTool implements AgentTool<typeof schema> {
	readonly name = "mempalace";
	readonly approval = () => "read" as const;
	readonly label = "MemPalace";
	readonly description = desc;
	readonly parameters = schema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Search, curate, and mine the native MemPalace long-term memory store";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MempalaceTool | null {
		if (session.settings.get("memory.backend") !== "mempalace-native") return null;
		return new MempalaceTool(session);
	}

	async execute(_id: string, params: MempalaceParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const state = this.session.getMempalaceNativeSessionState?.();
			if (!state) {
				throw new Error("MemPalace native backend is not initialised for this session.");
			}
			try {
				switch (params.action) {
					case "search":
						return await this.#search(state, params, signal);
					case "save":
						return this.#save(state, params);
					case "get":
						return this.#get(state, params);
					case "list":
						return this.#list(state, params);
					case "diary":
						return this.#diary(state, params);
					case "mine":
						return await this.#mine(state, params, signal);
					case "sync":
						return await this.#sync(state, params, signal);
					case "status":
						return this.#status(state);
				}
			} catch (err) {
				logger.warn("mempalace failed", { action: params.action, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		});
	}

	async #search(
		state: MempalaceNativeSession,
		params: MempalaceParams,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult> {
		const query = requireField(params.query, "query", "search");
		const wing = trimmed(params.wing);
		const room = trimmed(params.room);
		const result = await state.search({ text: query, limit: params.limit, wing, room, signal });
		return textResult(renderSearch(query, result, wing, room), result.hits.length === 0);
	}

	#save(state: MempalaceNativeSession, params: MempalaceParams): AgentToolResult {
		const content = requireField(params.content, "content", "save");
		const wing = trimmed(params.wing) ?? state.wing;
		const room = trimmed(params.room) ?? DEFAULT_ROOM;
		const title = trimmed(params.title) ?? deriveTitle(content);
		const written = state.save({
			wing,
			room,
			title,
			content,
			origin: "manual",
			source: TOOL_SOURCE,
			tags: params.tags,
		});
		// An empty id is the vault's non-throwing failure sentinel: the write did
		// not persist. Without this the zeroed result reads as `created: false,
		// updated: false`, i.e. exactly a duplicate, and we would report a
		// reassuring "already filed" for a drawer that was never stored.
		if (!written.id) {
			logger.warn("mempalace save did not persist", { wing, room });
			return textResult(`MemPalace could not file the drawer into ${wing}/${room}. Nothing was stored.`);
		}
		// Read the stored row back so the report names where the drawer actually
		// landed rather than where it was aimed.
		const filed = state.getDrawer(written.id);
		const where = filed ? `${filed.wing}/${filed.room}` : `${wing}/${room}`;
		if (written.created) return textResult(`Filed drawer ${written.id} into ${where}.`);
		if (written.updated) {
			return textResult(
				`Drawer ${written.id} in ${where} already held identical content; refreshed its title, room, and tags.`,
			);
		}
		return textResult(`Drawer already filed as ${written.id} in ${where} — identical content, nothing changed.`);
	}

	#get(state: MempalaceNativeSession, params: MempalaceParams): AgentToolResult {
		const id = requireField(params.id, "id", "get");
		const drawer = state.getDrawer(id);
		if (!drawer) {
			return textResult(
				`No drawer with id ${id}. Use \`mempalace search\` or \`mempalace list\` to find one.`,
				true,
			);
		}
		return textResult(renderDrawer(drawer));
	}

	#list(state: MempalaceNativeSession, params: MempalaceParams): AgentToolResult {
		const wing = trimmed(params.wing);
		const room = trimmed(params.room);
		if (!wing) {
			const wings = state.listWings();
			if (wings.length === 0) return textResult("The palace is empty — no wings yet.", true);
			const lines = wings.map(
				entry => `- ${entry.name} — ${plural(entry.roomCount, "room")}, ${plural(entry.drawerCount, "drawer")}`,
			);
			return textResult([`${plural(wings.length, "wing")}:`, ...lines].join("\n"));
		}
		if (!room) {
			const rooms = state.listRooms(wing);
			if (rooms.length === 0) return textResult(`Wing ${wing} has no rooms.`, true);
			const lines = rooms.map(entry => `- ${entry.wing}/${entry.name} — ${plural(entry.drawerCount, "drawer")}`);
			return textResult([`${plural(rooms.length, "room")} in wing ${wing}:`, ...lines].join("\n"));
		}
		const drawers = state.listDrawers({ wing, room, limit: params.limit });
		if (drawers.length === 0) return textResult(`No drawers in ${wing}/${room}.`, true);
		const lines: string[] = [`${plural(drawers.length, "drawer")} in ${wing}/${room}:`];
		drawers.forEach((drawer, index) => {
			lines.push(`${index + 1}. ${drawer.title}`, `   id: ${drawer.id} · created ${drawer.createdAt}`);
		});
		return textResult(lines.join("\n"));
	}

	#diary(state: MempalaceNativeSession, params: MempalaceParams): AgentToolResult {
		const content = trimmed(params.content);
		if (content) {
			const wing = trimmed(params.wing) ?? state.wing;
			const entry = state.writeDiary({ wing, content, tags: params.tags });
			// Same zero-value sentinel as `save`: an empty id means nothing landed.
			if (!entry.id) {
				logger.warn("mempalace diary write did not persist", { wing });
				return textResult(`MemPalace could not write the diary entry to wing ${wing}. Nothing was stored.`);
			}
			return textResult(`Wrote diary entry ${entry.id} to wing ${entry.wing} at ${entry.createdAt}.`);
		}
		// Omitting the wing reads every wing, which is the widest useful "recent".
		const wing = trimmed(params.wing);
		const entries = state.readDiary({ wing, limit: params.limit });
		if (entries.length === 0) return textResult(`No diary entries${scopeSuffix(wing, undefined)}.`, true);
		const heading = `${plural(entries.length, "diary entry", "diary entries")}${scopeSuffix(wing, undefined)}:`;
		const lines: string[] = [heading];
		for (const entry of entries) {
			const tags = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
			lines.push("", `${entry.createdAt} · ${entry.wing}${tags}`, entry.content);
		}
		return textResult(lines.join("\n"));
	}

	async #mine(
		state: MempalaceNativeSession,
		params: MempalaceParams,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult> {
		const dir = requireField(params.dir, "dir", "mine");
		const force = params.force === true;
		const options: MineOptions = { dir, wing: trimmed(params.wing) ?? state.wing, force, signal };
		if (params.plan === true) return textResult(renderPlan(dir, await state.planMine(options), force));
		return textResult(renderMine(dir, await state.mine(options), force));
	}

	async #sync(
		state: MempalaceNativeSession,
		params: MempalaceParams,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult> {
		const result = await state.sync({ wing: trimmed(params.wing), dir: trimmed(params.dir), signal });
		return textResult(
			`Sync complete: checked ${plural(result.checked, "source")}, pruned ${plural(result.pruned, "drawer")}.`,
		);
	}

	#status(state: MempalaceNativeSession): AgentToolResult {
		const lines = [...renderStats(state.stats()), ""];
		lines.push(
			state.embeddingsActive()
				? "Embeddings: active — search fuses lexical and vector hits."
				: "Embeddings: inactive — search is lexical-only.",
			"",
			...renderScheduler(state.schedulerState()),
		);
		return textResult(lines.join("\n"));
	}
}

/** `undefined` for absent or whitespace-only input, so callers can `??` a default. */
function trimmed(value: string | undefined): string | undefined {
	const result = value?.trim();
	return result ? result : undefined;
}

function requireField(value: string | undefined, field: string, action: MempalaceParams["action"]): string {
	const result = trimmed(value);
	if (!result) throw new Error(`The \`${field}\` field is required for \`mempalace ${action}\`.`);
	return result;
}

function textResult(text: string, useless = false): AgentToolResult {
	const result: AgentToolResult = { content: [{ type: "text", text }], details: {} };
	return useless ? { ...result, useless: true } : result;
}

function plural(count: number, noun: string, pluralForm?: string): string {
	return `${count} ${count === 1 ? noun : (pluralForm ?? `${noun}s`)}`;
}

function scopeSuffix(wing: string | undefined, room: string | undefined): string {
	if (wing && room) return ` in ${wing}/${room}`;
	if (wing) return ` in wing ${wing}`;
	if (room) return ` in room ${room}`;
	return "";
}

/** Squash newlines so a multi-line snippet cannot break the numbered layout. */
function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function deriveTitle(content: string): string {
	const base = content.split("\n", 1)[0]?.trim() || content.trim();
	if (!base) return "Untitled";
	if (base.length <= DERIVED_TITLE_MAX) return base;
	return `${base.slice(0, DERIVED_TITLE_MAX - 1).trimEnd()}…`;
}

function formatMillis(millis: number): string {
	if (millis < 1000) return `${Math.round(millis)} ms`;
	if (millis < 60_000) return `${(millis / 1000).toFixed(1)} s`;
	return `${Math.floor(millis / 60_000)}m ${Math.round((millis % 60_000) / 1000)}s`;
}

/** Two-column block, label-aligned, so counts stay scannable. */
function renderRows(rows: readonly (readonly [string, string])[]): string[] {
	const width = Math.max(...rows.map(([label]) => label.length));
	return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`);
}

function renderSearch(query: string, result: SearchResult, wing: string | undefined, room: string | undefined): string {
	const scope = scopeSuffix(wing, room);
	if (result.hits.length === 0) {
		const lines = [`No drawers matched ${JSON.stringify(query)}${scope}.`];
		if (result.message) lines.push(result.message);
		lines.push("Broaden the query, drop the wing/room filter, or run `mempalace list` to see what the palace holds.");
		return lines.join("\n");
	}
	const lines = [
		`Found ${plural(result.hits.length, "drawer")} for ${JSON.stringify(query)}${scope} (${result.effectiveMode}):`,
	];
	if (result.message) lines.push(result.message);
	lines.push("");
	result.hits.forEach((hit, index) => {
		lines.push(
			`${index + 1}. ${hit.wing}/${hit.room} · ${hit.title}`,
			`   id: ${hit.drawerId} · score ${hit.score.toFixed(3)} · matched ${hit.matchedBy}`,
		);
		const snippet = collapse(hit.snippet);
		if (snippet) lines.push(`   ${snippet}`);
	});
	return lines.join("\n");
}

function renderDrawer(drawer: Drawer): string {
	const header = [
		`${drawer.wing}/${drawer.room} · ${drawer.title}`,
		`id: ${drawer.id} · origin: ${drawer.origin} · added by ${drawer.addedBy}`,
	];
	if (drawer.tags.length > 0) header.push(`tags: ${drawer.tags.join(", ")}`);
	if (drawer.source) header.push(`source: ${drawer.source}`);
	if (drawer.sourcePath) header.push(`path: ${drawer.sourcePath}`);
	header.push(
		drawer.updatedAt === drawer.createdAt
			? `created ${drawer.createdAt}`
			: `created ${drawer.createdAt}, updated ${drawer.updatedAt}`,
	);
	return [...header, "", drawer.content].join("\n");
}

function renderPlan(dir: string, plan: MinePlan, force: boolean): string {
	const lines = [
		`Mine plan for ${dir} (${plan.mode} mode) — dry run, nothing was read or filed.`,
		...renderRows([
			["candidate files", String(plan.candidateFiles)],
			["changed", String(plan.changedFiles)],
			["unchanged", String(plan.unchangedFiles)],
			["changed bytes", formatBytes(plan.changedBytes)],
			["estimated cost", formatMillis(plan.estimatedMillis)],
		]),
	];
	if (plan.truncated) lines.push("  NOTE: the walk hit its file cap, so these counts are a lower bound.");
	if (force) lines.push("  `force` is set, so the unchanged files would be re-read too.");
	lines.push(
		"",
		plan.changedFiles === 0 && !force
			? "Nothing to do: the ledger already covers every candidate. Skip the mine."
			: "Re-run without `plan` to mine for real.",
	);
	return lines.join("\n");
}

function renderMine(dir: string, result: MineResult, force: boolean): string {
	const lines = [
		`Mined ${dir} (${result.mode} mode) in ${formatMillis(result.elapsedMillis)}.`,
		...renderRows([
			["files scanned", String(result.filesScanned)],
			["files skipped", String(result.filesSkipped)],
			["proved unchanged", String(result.filesUnchanged)],
			["drawers created", String(result.drawersCreated)],
			["drawers updated", String(result.drawersUpdated)],
		]),
		// `completed: false` is overloaded. A slice that simply hit its budget or
		// file cap is the normal Smart Mining path and carries no warnings; the
		// miner's degraded fallback always carries at least one. Reporting both
		// as "stopped early" would make routine sliced progress look like a fault.
		result.completed
			? "  Run completed."
			: result.warnings.length > 0
				? "  Run did not finish and reported problems — see the warnings below. Work remains."
				: "  Run stopped early on its budget, file cap, or an abort — the normal sliced path; work remains and the scheduler resumes it on the next slice.",
	];
	if (force) lines.push("  `force` was set: files the ledger considered unchanged were re-read.");
	if (result.warnings.length > 0) {
		lines.push("", `Warnings (${result.warnings.length}):`, ...result.warnings.map(warning => `  - ${warning}`));
	}
	return lines.join("\n");
}

function renderStats(stats: VaultStats): string[] {
	const rows: (readonly [string, string])[] = [
		["wings", String(stats.wings)],
		["rooms", String(stats.rooms)],
		["drawers", String(stats.drawers)],
		["diary entries", String(stats.diaryEntries)],
		["vectors", String(stats.vectors)],
		["database", formatBytes(stats.dbBytes)],
	];
	if (stats.lastWriteAt) rows.push(["last write", stats.lastWriteAt]);
	return ["Palace", ...renderRows(rows)];
}

function renderScheduler(state: MineSchedulerState | undefined): string[] {
	if (!state) {
		return [
			"Smart Mining: no scheduler in this session — subagents never mine, and automatic ingest may also be off.",
		];
	}
	const rows: (readonly [string, string])[] = [
		["running", state.running ? "yes — a mine slice is in flight" : "no"],
		["turns since mine", String(state.turnsSinceMine)],
		["idle streak", String(state.idleStreak)],
		["resume pending", state.resumePending ? "yes — a truncated run has work left" : "no"],
	];
	if (state.lastRunAt) rows.push(["last run", state.lastRunAt]);
	if (state.lastDecision) {
		rows.push([
			"last decision",
			`${state.lastDecision.run ? "run" : "skip"} (${state.lastDecision.trigger}) — ${state.lastDecision.reason}`,
		]);
	}
	if (state.lastResult) {
		const outcome = state.lastResult.completed ? "completed" : "truncated";
		rows.push([
			"last result",
			`${state.lastResult.drawersCreated} created, ${state.lastResult.drawersUpdated} updated, ${outcome}`,
		]);
	}
	return ["Smart Mining", ...renderRows(rows)];
}
