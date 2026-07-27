/**
 * WakaTime stats reader.
 *
 * Coding-time totals come from the REST API rather than `wakatime-cli --today`, which reports an
 * empty string on machines that demonstrably have data. Only the local offline-queue depth is read
 * back out of the CLI, since that state never leaves the machine.
 *
 * Unlike heartbeats, these calls are user-initiated and surface in a tool result, so they throw
 * with an actionable message instead of failing silently.
 */
import { execCommand } from "../exec/exec";
import type { ExecFn, WakatimeConfig } from "./config";

/** Enough pages to cover any realistic project list without unbounded paging on a huge account. */
const MAX_PROJECT_PAGES = 5;

/** `--offline-count` is a local SQLite read; anything slower means the CLI is wedged. */
const OFFLINE_COUNT_TIMEOUT_MS = 10_000;

/** First bytes of an error body worth showing the user; the rest is HTML noise. */
const ERROR_BODY_LIMIT = 300;

/** Time recorded against a single project over the requested range. */
export interface WakatimeProjectTime {
	/** Project name as WakaTime resolved it (respects `[projectmap]` and `.wakatime-project`). */
	name: string;
	/** Human-readable duration, e.g. "1 hr 47 mins". */
	text: string;
	/** Duration in seconds. */
	seconds: number;
}

/** Aggregated coding time for one range, flattened across every day the API returned. */
export interface WakatimeSummary {
	/** The range that was requested, echoed back (e.g. "today", "last_7_days"). */
	range: string;
	/** Human-readable grand total, e.g. "6 hrs 21 mins". */
	total: string;
	/** Grand total in seconds. */
	totalSeconds: number;
	/** Per-project breakdown, largest first. */
	projects: WakatimeProjectTime[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Render seconds the way WakaTime does, for totals we had to aggregate ourselves. */
function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const hrs = Math.floor(total / 3600);
	const mins = Math.floor((total % 3600) / 60);
	if (hrs === 0 && mins === 0) return `${total} sec${total === 1 ? "" : "s"}`;
	const parts: string[] = [];
	if (hrs > 0) parts.push(`${hrs} hr${hrs === 1 ? "" : "s"}`);
	if (mins > 0) parts.push(`${mins} min${mins === 1 ? "" : "s"}`);
	return parts.join(" ");
}

/** GET a WakaTime endpoint and parse it as JSON, translating failures into actionable errors. */
async function getJson(
	config: WakatimeConfig,
	pathname: string,
	params: Record<string, string>,
	fetchImpl: typeof fetch,
): Promise<unknown> {
	const apiKey = config.apiKey;
	if (!apiKey) {
		throw new Error(
			"No WakaTime API key found. Set WAKATIME_API_KEY, or add `api_key` under `[settings]` in ~/.wakatime.cfg (get one at https://wakatime.com/api-key).",
		);
	}
	const url = new URL(`${config.apiUrl}${pathname}`);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

	const res = await fetchImpl(url.toString(), {
		headers: {
			// RFC 7617 Basic auth: the API key is the username, the password is empty.
			Authorization: `Basic ${Buffer.from(`${apiKey}:`, "utf-8").toString("base64")}`,
			Accept: "application/json",
		},
	});
	if (!res.ok) {
		if (res.status === 401 || res.status === 403) {
			throw new Error(
				`WakaTime rejected the API key (HTTP ${res.status}). Check WAKATIME_API_KEY / ~/.wakatime.cfg.`,
			);
		}
		let body = "";
		try {
			body = (await res.text()).trim().slice(0, ERROR_BODY_LIMIT);
		} catch {
			// The body is a nicety; the status code already carries the signal.
		}
		throw new Error(`WakaTime API request failed (HTTP ${res.status})${body ? `: ${body}` : ""}`);
	}
	try {
		return await res.json();
	} catch {
		throw new Error(`WakaTime API returned a malformed response for ${pathname}.`);
	}
}

/**
 * Fetch aggregated coding time for a range.
 *
 * The summaries endpoint answers per day, so multi-day ranges are folded into one total here:
 * WakaTime's own `cumulative_total` is preferred, falling back to summing the daily grand totals.
 * Per-project durations keep the API's verbatim `text` when a project appears on exactly one day,
 * and are re-rendered from the summed seconds otherwise.
 *
 * @param range - A WakaTime range keyword, e.g. "today", "yesterday", "last_7_days", "last_30_days".
 * @throws When no API key is configured, or the API rejects/mangles the request.
 */
export async function fetchSummary(
	config: WakatimeConfig,
	range: string,
	fetchImpl: typeof fetch = fetch,
): Promise<WakatimeSummary> {
	const body = asRecord(await getJson(config, "/users/current/summaries", { range }, fetchImpl));
	const days = Array.isArray(body?.data) ? body.data : [];

	const totals = new Map<string, { seconds: number; text: string | null }>();
	let summedSeconds = 0;
	let singleDayTotalText: string | null = null;

	for (const day of days) {
		const dayRecord = asRecord(day);
		if (!dayRecord) continue;

		const grandTotal = asRecord(dayRecord.grand_total);
		summedSeconds += asNumber(grandTotal?.total_seconds) ?? 0;
		if (days.length === 1) singleDayTotalText = asString(grandTotal?.text);

		const projects = Array.isArray(dayRecord.projects) ? dayRecord.projects : [];
		for (const project of projects) {
			const projectRecord = asRecord(project);
			const name = asString(projectRecord?.name);
			if (!name) continue;
			const seconds = asNumber(projectRecord?.total_seconds) ?? 0;
			const existing = totals.get(name);
			if (existing) {
				existing.seconds += seconds;
				// Summed across days, so the per-day label no longer describes the value.
				existing.text = null;
			} else {
				totals.set(name, { seconds, text: asString(projectRecord?.text) });
			}
		}
	}

	const cumulative = asRecord(body?.cumulative_total);
	const totalSeconds = asNumber(cumulative?.seconds) ?? summedSeconds;

	return {
		range,
		total: asString(cumulative?.text) ?? singleDayTotalText ?? formatDuration(totalSeconds),
		totalSeconds,
		projects: [...totals]
			.map(([name, entry]) => ({ name, text: entry.text ?? formatDuration(entry.seconds), seconds: entry.seconds }))
			.sort((a, b) => b.seconds - a.seconds),
	};
}

/**
 * List the user's WakaTime project names, newest first.
 *
 * Follows pagination up to {@link MAX_PROJECT_PAGES} pages and dedupes, since the API can repeat a
 * project across page boundaries while the list shifts under an active heartbeat stream.
 *
 * @throws When no API key is configured, or the API rejects/mangles the request.
 */
export async function fetchProjects(config: WakatimeConfig, fetchImpl: typeof fetch = fetch): Promise<string[]> {
	const names = new Set<string>();
	let totalPages = 1;

	for (let page = 1; page <= Math.min(totalPages, MAX_PROJECT_PAGES); page++) {
		const body = asRecord(await getJson(config, "/users/current/projects", { page: String(page) }, fetchImpl));
		if (!body) break;

		const reported = asNumber(body.total_pages);
		if (reported !== null && reported > totalPages) totalPages = reported;

		const data = Array.isArray(body.data) ? body.data : [];
		for (const entry of data) {
			const name = asString(asRecord(entry)?.name);
			if (name) names.add(name);
		}
		if (data.length === 0) break;
	}

	return [...names];
}

/**
 * Depth of the local offline heartbeat queue via `wakatime-cli --offline-count`; null when unavailable.
 *
 * A non-zero depth means heartbeats were recorded but not yet accepted by the API — usually a
 * missing key or no network. Never throws.
 */
export async function offlineQueueDepth(config: WakatimeConfig, exec: ExecFn = execCommand): Promise<number | null> {
	if (!config.cliPath) return null;
	try {
		const result = await exec(config.cliPath, ["--offline-count"], process.cwd(), {
			timeout: OFFLINE_COUNT_TIMEOUT_MS,
		});
		if (result.code !== 0 || result.killed) return null;
		const parsed = Number.parseInt(result.stdout.trim(), 10);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
	} catch {
		return null;
	}
}
