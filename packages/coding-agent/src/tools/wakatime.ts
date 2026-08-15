import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import wakatimeDescription from "../prompts/tools/wakatime.md" with { type: "text" };
import { type ProjectNameSource, resolveProjectNameDetailed } from "../usage/project-resolver";
import {
	fetchProjects,
	fetchSummary,
	offlineQueueDepth,
	resolveWakatimeConfig,
	type WakatimeConfig,
	type WakatimeSummary,
} from "../wakatime";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { toolResult } from "./tool-result";

/** Windows the WakaTime summaries endpoint accepts. */
const WAKATIME_RANGES = ["today", "yesterday", "last_7_days", "last_30_days", "last_6_months", "last_year"] as const;

type WakatimeRange = (typeof WAKATIME_RANGES)[number];

const DEFAULT_STATS_RANGE: WakatimeRange = "last_7_days";

const RANGE_LABELS: Record<WakatimeRange, string> = {
	today: "Today",
	yesterday: "Yesterday",
	last_7_days: "Last 7 days",
	last_30_days: "Last 30 days",
	last_6_months: "Last 6 months",
	last_year: "Last year",
};

const MISSING_API_KEY_MESSAGE = [
	"No WakaTime API key found.",
	"Set WAKATIME_API_KEY in the environment, or add `api_key = <key>` under `[settings]` in ~/.wakatime.cfg.",
	"Keys live at https://wakatime.com/api-key.",
	'Re-check the setup with action "status".',
].join(" ");

/** How each detection rule reads in the `project` report. */
const PROJECT_SOURCE_LABELS: Record<ProjectNameSource, string> = {
	file: ".wakatime-project file",
	projectmap: "[projectmap] rule in ~/.wakatime.cfg",
	git: "git repository folder",
	basename: "directory name (no WakaTime rule matched)",
};

const wakatimeSchema = type({
	action: "'today' | 'stats' | 'projects' | 'project' | 'status'",
	"range?": type("string").describe(
		`reporting window for "stats" (default ${DEFAULT_STATS_RANGE}): ${WAKATIME_RANGES.join(", ")}`,
	),
});

export type WakatimeParams = typeof wakatimeSchema.infer;

export interface WakatimeToolDetails {
	action: WakatimeParams["action"];
	/** Resolved window for `today`/`stats`; absent for the local and list actions. */
	range?: string;
	totalSeconds?: number;
	projectCount?: number;
	/** Resolved project name for `project`. */
	project?: string;
	/** Which rule named it. */
	projectSource?: ProjectNameSource;
	meta?: OutputMeta;
}

function isWakatimeRange(value: string): value is WakatimeRange {
	return (WAKATIME_RANGES as readonly string[]).includes(value);
}

/**
 * Render a summary as a grand total plus a longest-first project breakdown.
 * Zero-second projects are dropped — WakaTime returns an entry for every known
 * project in the window, most of them empty.
 */
function renderSummary(summary: WakatimeSummary, label: string): string {
	const projects = summary.projects.filter(project => project.seconds > 0).sort((a, b) => b.seconds - a.seconds);
	if (projects.length === 0) {
		return summary.totalSeconds > 0
			? `${label}: ${summary.total} (no per-project breakdown returned)`
			: `${label}: no coding activity recorded`;
	}
	const width = Math.max(...projects.map(project => project.name.length));
	const lines = [`${label}: ${summary.total}`, ""];
	for (const project of projects) {
		lines.push(`  ${project.name.padEnd(width)}  ${project.text}`);
	}
	return lines.join("\n");
}

/**
 * Read-only view over the user's WakaTime account: coding totals, project
 * list, how the current directory is named, and local tracker health. Gated
 * behind `wakatime.enabled` — the whole integration is opt-in because it sends
 * file paths and project names to WakaTime.
 */
export class WakatimeTool implements AgentTool<typeof wakatimeSchema> {
	readonly name = "wakatime";
	readonly approval = () => "read" as const;
	readonly label = "WakaTime";
	readonly description = wakatimeDescription;
	readonly parameters = wakatimeSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary =
		"Report WakaTime coding-time totals, per-project breakdowns, the resolved project name, and tracker status";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): WakatimeTool | null {
		if (!session.settings.get("wakatime.enabled")) return null;
		return new WakatimeTool(session);
	}

	async execute(_id: string, params: WakatimeParams): Promise<AgentToolResult<WakatimeToolDetails>> {
		const config = await resolveWakatimeConfig({
			cliPath: this.session.settings.get("wakatime.cliPath")?.trim() || undefined,
		});

		// `status` is the diagnostic path: it must work precisely when the rest
		// does not, so it runs before the API-key guard. `project` is local-only
		// name resolution, so it needs no key either.
		if (params.action === "status") return await this.#status(config);
		if (params.action === "project") return await this.#project();

		if (!config.apiKey) {
			return toolResult<WakatimeToolDetails>({ action: params.action }).text(MISSING_API_KEY_MESSAGE).error().done();
		}

		// The session fetch carries the harness's proxy/CA/policy wrappers; fall
		// back to the module default when the session does not inject one.
		const fetchImpl = this.session.fetch as typeof fetch | undefined;
		try {
			if (params.action === "projects") return await this.#projects(config, fetchImpl);

			const requested = params.action === "today" ? "today" : params.range?.trim() || DEFAULT_STATS_RANGE;
			if (!isWakatimeRange(requested)) {
				return toolResult<WakatimeToolDetails>({ action: params.action })
					.text(`Unknown range ${JSON.stringify(requested)}. Valid: ${WAKATIME_RANGES.join(", ")}.`)
					.error()
					.done();
			}
			const summary = await fetchSummary(config, requested, fetchImpl);
			return toolResult<WakatimeToolDetails>({
				action: params.action,
				range: requested,
				totalSeconds: summary.totalSeconds,
				projectCount: summary.projects.filter(project => project.seconds > 0).length,
			})
				.text(renderSummary(summary, RANGE_LABELS[requested]))
				.done();
		} catch (error) {
			// Surface the upstream failure verbatim minus the API key: some HTTP
			// clients echo the credential back in the error payload.
			const raw = error instanceof Error ? error.message : String(error);
			const reason = config.apiKey ? raw.replaceAll(config.apiKey, "<redacted>") : raw;
			return toolResult<WakatimeToolDetails>({ action: params.action })
				.text(`WakaTime request failed: ${reason}`)
				.error()
				.done();
		}
	}

	async #projects(
		config: WakatimeConfig,
		fetchImpl: typeof fetch | undefined,
	): Promise<AgentToolResult<WakatimeToolDetails>> {
		const projects = await fetchProjects(config, fetchImpl);
		const sorted = [...projects].sort((a, b) => a.localeCompare(b));
		const details: WakatimeToolDetails = { action: "projects", projectCount: sorted.length };
		if (sorted.length === 0) {
			return toolResult(details).text("No WakaTime projects found.").done();
		}
		return toolResult(details)
			.text(`${sorted.length} WakaTime project${sorted.length === 1 ? "" : "s"}: ${sorted.join(", ")}`)
			.done();
	}

	/**
	 * Which project name the session's directory maps to, and which of wakatime-cli's
	 * rules decided it. Purely local: no API key, no network, no subprocess.
	 */
	async #project(): Promise<AgentToolResult<WakatimeToolDetails>> {
		const { project, source } = await resolveProjectNameDetailed(this.session.cwd);
		return toolResult<WakatimeToolDetails>({ action: "project", project, projectSource: source })
			.text(
				[
					`Project: ${project}`,
					`Resolved by: ${PROJECT_SOURCE_LABELS[source]}`,
					`Directory: ${this.session.cwd}`,
				].join("\n"),
			)
			.done();
	}

	async #status(config: WakatimeConfig): Promise<AgentToolResult<WakatimeToolDetails>> {
		const heartbeats = this.session.settings.get("wakatime.heartbeats");
		const category = this.session.settings.get("wakatime.category");
		const queued = await offlineQueueDepth(config);
		const lines = [
			`wakatime-cli: ${config.cliPath ?? "not installed"}`,
			`API key: ${config.apiKey ? "found" : "not found"}`,
			`API URL: ${config.apiUrl}`,
			`Heartbeats: ${heartbeats ? `enabled (category "${category}")` : "disabled"}`,
			`Offline queue: ${queued === null ? "unavailable" : `${queued} heartbeat${queued === 1 ? "" : "s"} pending`}`,
		];
		if (!config.cliPath) {
			lines.push(
				"",
				"Install wakatime-cli (https://github.com/wakatime/wakatime-cli/releases) or point wakatime.cliPath at it to record heartbeats.",
			);
		}
		if (!config.apiKey) lines.push("", MISSING_API_KEY_MESSAGE);
		return toolResult<WakatimeToolDetails>({ action: "status" }).text(lines.join("\n")).done();
	}
}
