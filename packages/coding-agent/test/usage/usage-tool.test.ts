/**
 * Behavioural tests for the agent-facing `usage` tool.
 *
 * The `session` action is exercised against stubbed session tallies and a
 * stubbed transcript; `project`/`models` are exercised against namespace spies
 * on the ledger module, so no test here opens a database. Spies are installed
 * with `vi.spyOn` (never `mock.module`, which would leak into the ledger's own
 * test file) and removed by the `afterEach` restore.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionEntry, UsageStatistics } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { formatUsd, UsageTool, type UsageToolDetails } from "@oh-my-pi/pi-coding-agent/tools/usage";
import * as costLedger from "@oh-my-pi/pi-coding-agent/usage/cost-ledger";
import * as projectResolver from "@oh-my-pi/pi-coding-agent/usage/project-resolver";

const EMPTY_STATS: UsageStatistics = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	orchestrationInput: 0,
	orchestrationOutput: 0,
	orchestrationCacheRead: 0,
	premiumRequests: 0,
	cost: 0,
};

interface SessionParts {
	enabled?: boolean;
	stats?: UsageStatistics;
	/** Omit to build a session with no `sessionManager` at all. */
	entries?: SessionEntry[];
	cwd?: string;
}

function createSession(parts: SessionParts = {}): ToolSession {
	const { entries } = parts;
	const session: ToolSession = {
		cwd: parts.cwd ?? "/tmp/usage-tool-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "usage.enabled": parts.enabled ?? true }),
	};
	const { stats } = parts;
	if (stats) session.getUsageStatistics = () => stats;
	if (entries) {
		// The tool reads only `getEntries`; standing up a real SessionManager
		// would drag session files and blob storage into a rendering test.
		const sessionManager = { getEntries: () => entries } as unknown as NonNullable<ToolSession["sessionManager"]>;
		session.sessionManager = sessionManager;
	}
	return session;
}

function usage(totalTokens: number, cost: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

let entryId = 0;

function messageEntry(message: AssistantMessage | ToolResultMessage): SessionEntry {
	entryId += 1;
	return { type: "message", id: `e${entryId}`, parentId: null, timestamp: "2026-07-27T00:00:00.000Z", message };
}

function assistantEntry(model: string, provider: string, totalTokens: number, cost: number): SessionEntry {
	return messageEntry({
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider,
		model,
		usage: usage(totalTokens, cost),
		stopReason: "stop",
		timestamp: 0,
	});
}

function toolResultEntry(toolName: string, details: unknown): SessionEntry {
	return messageEntry({
		role: "toolResult",
		toolCallId: `call-${toolName}`,
		toolName,
		content: [],
		details,
		isError: false,
		timestamp: 0,
	});
}

function textOf(result: AgentToolResult<UsageToolDetails>): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("UsageTool.createIf", () => {
	it("builds the tool when usage.enabled is on", () => {
		expect(UsageTool.createIf(createSession({ enabled: true }))).toBeInstanceOf(UsageTool);
	});

	it("returns null when usage.enabled is off", () => {
		expect(UsageTool.createIf(createSession({ enabled: false }))).toBeNull();
	});
});

describe("usage session action", () => {
	it("renders session totals and omits zero orchestration and premium rows", async () => {
		const tool = new UsageTool(
			createSession({
				stats: {
					...EMPTY_STATS,
					input: 12_000,
					output: 3_400,
					cacheRead: 900_000,
					cacheWrite: 45_000,
					totalTokens: 960_400,
					cost: 1.2345,
				},
			}),
		);

		const result = await tool.execute("t", { action: "session" });
		const text = textOf(result);

		expect(result.isError).toBeUndefined();
		expect(text).toContain("Session usage");
		expect(text).toMatch(/Input tokens\s+12,000/);
		expect(text).toMatch(/Output tokens\s+3,400/);
		expect(text).toMatch(/Cache read tokens\s+900,000/);
		expect(text).toMatch(/Cache write tokens\s+45,000/);
		expect(text).toMatch(/Total tokens\s+960,400/);
		expect(text).toMatch(/Estimated cost\s+\$1\.23/);
		expect(text).not.toContain("Orchestration tokens");
		expect(text).not.toContain("Premium requests");
		expect(result.details?.costUsd).toBe(1.2345);
	});

	it("renders orchestration tokens and premium requests once they are non-zero", async () => {
		const tool = new UsageTool(
			createSession({
				stats: {
					...EMPTY_STATS,
					totalTokens: 500,
					orchestrationInput: 10,
					orchestrationOutput: 5,
					orchestrationCacheRead: 2,
					premiumRequests: 3,
					cost: 0.5,
				},
			}),
		);

		const text = textOf(await tool.execute("t", { action: "session" }));

		expect(text).toMatch(/Orchestration tokens\s+17/);
		expect(text).toMatch(/Premium requests\s+3/);
	});

	it("breaks spend down by model and reports task-subagent spend separately", async () => {
		const entries = [
			assistantEntry("claude-sonnet-4", "anthropic", 100, 0.2),
			assistantEntry("claude-sonnet-4", "anthropic", 50, 0.1),
			assistantEntry("gpt-5", "openai", 10, 0.05),
			toolResultEntry("task", { usage: usage(500, 0.3) }),
			toolResultEntry("read", { usage: usage(999, 9.99) }),
			toolResultEntry("task", { path: "/tmp/no-usage-here" }),
		];
		const tool = new UsageTool(createSession({ stats: { ...EMPTY_STATS, totalTokens: 660, cost: 0.65 }, entries }));

		const result = await tool.execute("t", { action: "session" });
		const text = textOf(result);

		expect(text).toContain("By model (orchestration only)");
		expect(text).toMatch(/claude-sonnet-4\s+anthropic\s+\$0\.30\s+150 tokens\s+2 msgs/);
		expect(text).toMatch(/gpt-5\s+openai\s+\$0\.05\s+10 tokens\s+1 msg\b/);
		// Most expensive model first.
		expect(text.indexOf("claude-sonnet-4")).toBeLessThan(text.indexOf("gpt-5"));
		// 0.2 + 0.1 must not leak binary float noise into the report.
		expect(text).not.toContain("0.30000000000000004");
		// Only the `task` result with a usage payload counts.
		expect(text).toContain("Subagents (task tool): $0.30 over 500 tokens in 1 call.");
		expect(text).not.toContain("9.99");
		expect(result.details?.rowCount).toBe(2);
	});

	it("says so when no task subagent ran", async () => {
		const tool = new UsageTool(
			createSession({
				stats: { ...EMPTY_STATS, cost: 0.02 },
				entries: [assistantEntry("gpt-5", "openai", 10, 0.02)],
			}),
		);

		expect(textOf(await tool.execute("t", { action: "session" }))).toContain("Subagents (task tool): none.");
	});

	it("degrades to totals-only when the session exposes no sessionManager", async () => {
		const tool = new UsageTool(createSession({ stats: { ...EMPTY_STATS, totalTokens: 42, cost: 0.75 } }));

		const result = await tool.execute("t", { action: "session" });
		const text = textOf(result);

		expect(result.isError).toBeUndefined();
		expect(text).toMatch(/Total tokens\s+42/);
		expect(text).toMatch(/Estimated cost\s+\$0\.75/);
		expect(text).toContain("Per-model breakdown unavailable");
		expect(text).not.toContain("By model");
	});

	it("errors when the session exposes no usage statistics at all", async () => {
		const result = await new UsageTool(createSession()).execute("t", { action: "session" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Session usage statistics are unavailable");
	});
});

describe("usage project action", () => {
	const rows: costLedger.ProjectTotals[] = [
		{
			project: "oh-my-pi",
			costUsd: 12.5,
			inputTokens: 100,
			outputTokens: 200,
			cacheReadTokens: 300,
			cacheWriteTokens: 400,
			totalTokens: 1_000,
			sessions: 4,
			firstRecordedAt: 1_000,
			lastRecordedAt: Date.now() - 2 * 60 * 60 * 1000,
		},
		{
			project: "side-quest",
			costUsd: 0.004,
			inputTokens: 1,
			outputTokens: 2,
			cacheReadTokens: 3,
			cacheWriteTokens: 4,
			totalTokens: 10,
			sessions: 1,
			firstRecordedAt: 1_000,
			lastRecordedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
		},
	];

	it("narrows to the resolved project by default and renders costliest first", async () => {
		vi.spyOn(projectResolver, "resolveProjectName").mockResolvedValue("oh-my-pi");
		// Deliberately out of order — the tool sorts, it does not trust the ledger.
		const query = vi.spyOn(costLedger, "queryProjectTotals").mockReturnValue([rows[1], rows[0]]);

		const result = await new UsageTool(createSession()).execute("t", { action: "project" });
		const text = textOf(result);

		expect(query).toHaveBeenCalledTimes(1);
		const [options] = query.mock.calls[0];
		expect(options?.project).toBe("oh-my-pi");
		expect(options?.since).toBeGreaterThan(0);
		expect(text).toContain("Project cost — Last 30 days (project oh-my-pi)");
		expect(text).toMatch(/oh-my-pi\s+\$12\.50\s+1,000 tokens\s+4 sessions\s+2h ago/);
		expect(text).toMatch(/side-quest\s+\$0\.004\s+10 tokens\s+1 session\s+3d ago/);
		expect(text.indexOf("oh-my-pi")).toBeLessThan(text.indexOf("side-quest"));
		expect(text).toContain("Total: $12.50");
		expect(text).toContain("Costs are estimates");
		expect(result.details?.rowCount).toBe(2);
	});

	it("drops the project filter for scope all and the lower bound for since all", async () => {
		const resolve = vi.spyOn(projectResolver, "resolveProjectName");
		const query = vi.spyOn(costLedger, "queryProjectTotals").mockReturnValue([rows[0]]);

		await new UsageTool(createSession()).execute("t", { action: "project", scope: "all", since: "all" });

		expect(resolve).not.toHaveBeenCalled();
		expect(query.mock.calls[0][0]).toEqual({ since: undefined, project: undefined });
	});

	it("explains the projectLedger setting when nothing has been recorded", async () => {
		vi.spyOn(projectResolver, "resolveProjectName").mockResolvedValue("oh-my-pi");
		vi.spyOn(costLedger, "queryProjectTotals").mockReturnValue([]);

		const result = await new UsageTool(createSession()).execute("t", { action: "project", since: "today" });

		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toBe(
			"No ledger entries for project oh-my-pi (today). Recording is controlled by the `usage.projectLedger` setting.",
		);
	});

	it("rejects an unknown since window before querying", async () => {
		const query = vi.spyOn(costLedger, "queryProjectTotals");

		const result = await new UsageTool(createSession()).execute("t", { action: "project", since: "last_week" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe('Unknown since "last_week". Valid: today, 7d, 30d, all.');
		expect(query).not.toHaveBeenCalled();
	});
});

describe("usage models action", () => {
	it("renders model, provider, cost, tokens, and request count", async () => {
		vi.spyOn(projectResolver, "resolveProjectName").mockResolvedValue("oh-my-pi");
		const query = vi.spyOn(costLedger, "queryModelTotals").mockReturnValue([
			{ model: "gpt-5", provider: "openai", costUsd: 0.25, totalTokens: 2_500, requests: 1 },
			{ model: "claude-sonnet-4", provider: "anthropic", costUsd: 3.5, totalTokens: 120_000, requests: 42 },
		]);

		const result = await new UsageTool(createSession()).execute("t", { action: "models", since: "7d" });
		const text = textOf(result);

		expect(query.mock.calls[0][0]?.project).toBe("oh-my-pi");
		expect(text).toContain("Model cost — Last 7 days (project oh-my-pi)");
		expect(text).toMatch(/claude-sonnet-4\s+anthropic\s+\$3\.50\s+120,000 tokens\s+42 requests/);
		expect(text).toMatch(/gpt-5\s+openai\s+\$0\.25\s+2,500 tokens\s+1 request\b/);
		expect(text.indexOf("claude-sonnet-4")).toBeLessThan(text.indexOf("gpt-5"));
		expect(text).toContain("Total: $3.75");
		expect(result.details?.costUsd).toBeCloseTo(3.75, 10);
	});

	it("reports an empty ledger without erroring", async () => {
		vi.spyOn(costLedger, "queryModelTotals").mockReturnValue([]);

		const result = await new UsageTool(createSession()).execute("t", { action: "models", scope: "all" });

		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toContain("No ledger entries for all projects (last 30 days).");
	});
});

describe("formatUsd", () => {
	it("uses two decimals from a cent upward", () => {
		expect(formatUsd(1234.5)).toBe("$1234.50");
		expect(formatUsd(12.005)).toBe("$12.01");
		expect(formatUsd(0.01)).toBe("$0.01");
	});

	it("keeps four significant digits below a cent without exponent notation", () => {
		expect(formatUsd(0.009999)).toBe("$0.009999");
		expect(formatUsd(0.0034)).toBe("$0.0034");
		expect(formatUsd(0.000001)).toBe("$0.000001");
	});

	it("never leaks accumulated float noise", () => {
		expect(formatUsd(0.1 + 0.2)).toBe("$0.30");
	});

	it("collapses zero and non-finite values", () => {
		expect(formatUsd(0)).toBe("$0.00");
		expect(formatUsd(Number.NaN)).toBe("$0.00");
	});
});
