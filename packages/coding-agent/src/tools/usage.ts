import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import usageDescription from "../prompts/tools/usage.md" with { type: "text" };
import type { SessionEntry } from "../session/session-entries";
import { taskToolUsage } from "../session/session-stats";
import { queryModelTotals, queryProjectTotals } from "../usage/cost-ledger";
import { resolveProjectName } from "../usage/project-resolver";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { toolResult } from "./tool-result";

/** Ledger windows accepted by `since`. */
const SINCE_WINDOWS = ["today", "7d", "30d", "all"] as const;

type SinceWindow = (typeof SINCE_WINDOWS)[number];

const DEFAULT_SINCE: SinceWindow = "30d";

const SINCE_LABELS: Record<SinceWindow, string> = {
	today: "Today",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
	all: "All time",
};

const DAY_MS = 24 * 60 * 60 * 1000;

const ESTIMATE_NOTE = "Costs are estimates from the model catalog's pricing, not billed amounts.";

const LEDGER_HINT = "Recording is controlled by the `usage.projectLedger` setting.";

const usageSchema = type({
	action: "'session' | 'project' | 'models'",
	"scope?": type("'current' | 'all'").describe(
		'ledger scope: "current" (default) reports this project only, "all" reports every project',
	),
	"since?": type("string").describe(
		`ledger window (default ${DEFAULT_SINCE}): ${SINCE_WINDOWS.join(", ")}. Ignored by "session"`,
	),
});

export type UsageParams = typeof usageSchema.infer;

export interface UsageToolDetails {
	action: UsageParams["action"];
	/** Resolved ledger window; absent for `session`. */
	since?: SinceWindow;
	/** Project the ledger query was narrowed to; absent when scope is `all` or for `session`. */
	project?: string;
	/** Total USD across the rendered rows (session cost for `session`). */
	costUsd?: number;
	/** Rendered breakdown rows: models for `session`/`models`, projects for `project`. */
	rowCount?: number;
	meta?: OutputMeta;
}

function isSinceWindow(value: string): value is SinceWindow {
	return (SINCE_WINDOWS as readonly string[]).includes(value);
}

/** Inclusive epoch-ms lower bound for a window, or `undefined` for `all`. */
function sinceLowerBound(window: SinceWindow, now: number): number | undefined {
	if (window === "all") return undefined;
	if (window === "today") {
		const midnight = new Date(now);
		midnight.setHours(0, 0, 0, 0);
		return midnight.getTime();
	}
	return now - (window === "7d" ? 7 : 30) * DAY_MS;
}

/**
 * USD with two decimals from a cent upward, four significant digits below it.
 * Everything is routed through `toFixed` so accumulated float noise
 * (`0.30000000000000004`) never reaches the model.
 */
export function formatUsd(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0.00";
	if (value >= 0.01) return `$${value.toFixed(2)}`;
	// `toPrecision` flips to exponent notation on tiny values, so derive the
	// decimal count from the magnitude instead and keep the output plain.
	const decimals = Math.min(12, 3 - Math.floor(Math.log10(value)));
	return `$${value.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/** Exact counts with thousands separators, pinned to en-US so output is host-independent. */
function formatTokens(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

/** `12s` / `34m` / `5h` / `6d` ago, so reports never depend on the reader's timezone. */
function formatAgo(timestamp: number, now: number): string {
	if (!timestamp) return "unknown";
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

type Align = "left" | "right";

/** Pad `rows` into aligned columns joined by two spaces. Columns default to left. */
function renderTable(rows: string[][], align: readonly Align[] = []): string[] {
	const widths: number[] = [];
	for (const row of rows) {
		for (const [index, cell] of row.entries()) widths[index] = Math.max(widths[index] ?? 0, cell.length);
	}
	return rows.map(row =>
		row
			.map((cell, index) => {
				const width = widths[index] ?? 0;
				return align[index] === "right" ? cell.padStart(width) : cell.padEnd(width);
			})
			.join("  ")
			.trimEnd(),
	);
}

interface ModelSpend {
	model: string;
	/** Distinct providers seen serving this model id; usually exactly one. */
	providers: Set<string>;
	tokens: number;
	costUsd: number;
	messages: number;
}

interface SessionBreakdown {
	/** Orchestration spend per model, most expensive first. Excludes subagents. */
	models: ModelSpend[];
	subagents: { tokens: number; costUsd: number; calls: number };
}

/**
 * Fold the transcript into per-model orchestration spend plus the aggregate
 * spend of `task` subagents. Subagent usage rides on the tool result's
 * `details`, so it is read through the same guard the stats tracker uses.
 */
function summarizeSessionEntries(entries: readonly SessionEntry[]): SessionBreakdown {
	const byModel = new Map<string, ModelSpend>();
	const subagents = { tokens: 0, costUsd: 0, calls: 0 };
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			const key = message.model || "unknown";
			let spend = byModel.get(key);
			if (!spend) {
				spend = { model: key, providers: new Set(), tokens: 0, costUsd: 0, messages: 0 };
				byModel.set(key, spend);
			}
			if (message.provider) spend.providers.add(message.provider);
			spend.tokens += message.usage.totalTokens;
			spend.costUsd += message.usage.cost.total;
			spend.messages += 1;
			continue;
		}
		if (message.role !== "toolResult" || message.toolName !== "task") continue;
		const usage = taskToolUsage(message.details);
		if (!usage) continue;
		subagents.tokens += usage.totalTokens;
		subagents.costUsd += usage.cost.total;
		subagents.calls += 1;
	}
	const models = [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model));
	return { models, subagents };
}

/**
 * Read-only view over what this session and this project have spent.
 * `session` reads the live in-memory tallies; `project` and `models` read the
 * local SQLite cost ledger. Gated behind `usage.enabled`.
 */
export class UsageTool implements AgentTool<typeof usageSchema> {
	readonly name = "usage";
	readonly approval = () => "read" as const;
	readonly label = "Usage";
	readonly description = usageDescription;
	readonly parameters = usageSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Report live session token spend and per-project estimated cost from the local ledger";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): UsageTool | null {
		if (!session.settings.get("usage.enabled")) return null;
		return new UsageTool(session);
	}

	async execute(_id: string, params: UsageParams): Promise<AgentToolResult<UsageToolDetails>> {
		if (params.action === "session") return this.#sessionReport();

		const requested = params.since?.trim() || DEFAULT_SINCE;
		if (!isSinceWindow(requested)) {
			return toolResult<UsageToolDetails>({ action: params.action })
				.text(`Unknown since ${JSON.stringify(requested)}. Valid: ${SINCE_WINDOWS.join(", ")}.`)
				.error()
				.done();
		}
		const now = Date.now();
		const lowerBound = sinceLowerBound(requested, now);
		// `scope: "all"` drops the project filter; anything else narrows to the
		// project the ledger attributes this working directory to.
		const project = params.scope === "all" ? undefined : await resolveProjectName(this.session.cwd);
		return params.action === "project"
			? this.#projectReport(requested, lowerBound, project, now)
			: this.#modelReport(requested, lowerBound, project);
	}

	/** Live session tallies plus the per-model and subagent split behind them. */
	#sessionReport(): AgentToolResult<UsageToolDetails> {
		const stats = this.session.getUsageStatistics?.();
		if (!stats) {
			return toolResult<UsageToolDetails>({ action: "session" })
				.text("Session usage statistics are unavailable in this context.")
				.error()
				.done();
		}
		const orchestration = stats.orchestrationInput + stats.orchestrationOutput + stats.orchestrationCacheRead;
		const totals: string[][] = [
			["Input tokens", formatTokens(stats.input)],
			["Output tokens", formatTokens(stats.output)],
			["Cache read tokens", formatTokens(stats.cacheRead)],
			["Cache write tokens", formatTokens(stats.cacheWrite)],
			["Total tokens", formatTokens(stats.totalTokens)],
		];
		if (orchestration > 0) totals.push(["Orchestration tokens", formatTokens(orchestration)]);
		if (stats.premiumRequests > 0) totals.push(["Premium requests", formatTokens(stats.premiumRequests)]);
		totals.push(["Estimated cost", formatUsd(stats.cost)]);
		const lines = ["Session usage", ...renderTable(totals, ["left", "right"]).map(line => `  ${line}`)];

		const entries = this.session.sessionManager?.getEntries();
		if (!entries) {
			lines.push("", "Per-model breakdown unavailable: no session transcript in this context.", ESTIMATE_NOTE);
			return toolResult<UsageToolDetails>({ action: "session", costUsd: stats.cost }).text(lines.join("\n")).done();
		}

		const { models, subagents } = summarizeSessionEntries(entries);
		if (models.length > 0) {
			const rows = models.map(spend => [
				spend.model,
				spend.providers.size > 0 ? [...spend.providers].sort().join("+") : "unknown",
				formatUsd(spend.costUsd),
				`${formatTokens(spend.tokens)} tokens`,
				`${formatTokens(spend.messages)} msg${spend.messages === 1 ? "" : "s"}`,
			]);
			lines.push(
				"",
				"By model (orchestration only)",
				...renderTable(rows, ["left", "left", "right", "right", "right"]).map(line => `  ${line}`),
			);
		}
		lines.push(
			"",
			subagents.calls > 0
				? `Subagents (task tool): ${formatUsd(subagents.costUsd)} over ${formatTokens(subagents.tokens)} tokens in ${formatTokens(subagents.calls)} call${subagents.calls === 1 ? "" : "s"}. Counted in the totals above, excluded from the by-model rows.`
				: "Subagents (task tool): none.",
			ESTIMATE_NOTE,
		);
		return toolResult<UsageToolDetails>({ action: "session", costUsd: stats.cost, rowCount: models.length })
			.text(lines.join("\n"))
			.done();
	}

	#projectReport(
		since: SinceWindow,
		lowerBound: number | undefined,
		project: string | undefined,
		now: number,
	): AgentToolResult<UsageToolDetails> {
		const totals = queryProjectTotals({ since: lowerBound, project });
		const scopeLabel = project ? `project ${project}` : "all projects";
		const details: UsageToolDetails = { action: "project", since, ...(project ? { project } : {}) };
		if (totals.length === 0) {
			return toolResult<UsageToolDetails>(details)
				.text(`No ledger entries for ${scopeLabel} (${SINCE_LABELS[since].toLowerCase()}). ${LEDGER_HINT}`)
				.done();
		}
		const sorted = [...totals].sort((a, b) => b.costUsd - a.costUsd || a.project.localeCompare(b.project));
		const grandTotal = sorted.reduce((sum, row) => sum + row.costUsd, 0);
		const rows = sorted.map(row => [
			row.project,
			formatUsd(row.costUsd),
			`${formatTokens(row.totalTokens)} tokens`,
			`${formatTokens(row.sessions)} session${row.sessions === 1 ? "" : "s"}`,
			formatAgo(row.lastRecordedAt, now),
		]);
		const lines = [
			`Project cost — ${SINCE_LABELS[since]} (${scopeLabel})`,
			"",
			...renderTable(rows, ["left", "right", "right", "right", "right"]).map(line => `  ${line}`),
		];
		if (sorted.length > 1) lines.push("", `Total: ${formatUsd(grandTotal)}`);
		lines.push("", ESTIMATE_NOTE);
		return toolResult<UsageToolDetails>({ ...details, costUsd: grandTotal, rowCount: sorted.length })
			.text(lines.join("\n"))
			.done();
	}

	#modelReport(
		since: SinceWindow,
		lowerBound: number | undefined,
		project: string | undefined,
	): AgentToolResult<UsageToolDetails> {
		const totals = queryModelTotals({ since: lowerBound, project });
		const scopeLabel = project ? `project ${project}` : "all projects";
		const details: UsageToolDetails = { action: "models", since, ...(project ? { project } : {}) };
		if (totals.length === 0) {
			return toolResult<UsageToolDetails>(details)
				.text(`No ledger entries for ${scopeLabel} (${SINCE_LABELS[since].toLowerCase()}). ${LEDGER_HINT}`)
				.done();
		}
		const sorted = [...totals].sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model));
		const grandTotal = sorted.reduce((sum, row) => sum + row.costUsd, 0);
		const rows = sorted.map(row => [
			row.model,
			row.provider,
			formatUsd(row.costUsd),
			`${formatTokens(row.totalTokens)} tokens`,
			`${formatTokens(row.requests)} request${row.requests === 1 ? "" : "s"}`,
		]);
		const lines = [
			`Model cost — ${SINCE_LABELS[since]} (${scopeLabel})`,
			"",
			...renderTable(rows, ["left", "left", "right", "right", "right"]).map(line => `  ${line}`),
			"",
			`Total: ${formatUsd(grandTotal)}`,
			ESTIMATE_NOTE,
		];
		return toolResult<UsageToolDetails>({ ...details, costUsd: grandTotal, rowCount: sorted.length })
			.text(lines.join("\n"))
			.done();
	}
}
