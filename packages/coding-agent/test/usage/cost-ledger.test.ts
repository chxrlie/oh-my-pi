/**
 * Storage + aggregation tests for the per-project usage cost ledger.
 *
 * Every test isolates `OMP_USAGE_LEDGER_DB` to a temp file and calls
 * `closeLedger()` on both sides so the module-level connection (and its
 * `openAttempted` latch) never leaks between cases.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	closeLedger,
	type LedgerEntry,
	queryModelTotals,
	queryProjectTotals,
	recordLedgerEntry,
} from "@oh-my-pi/pi-coding-agent/usage/cost-ledger";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let tempDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-ledger-"));
	originalEnv = process.env.OMP_USAGE_LEDGER_DB;
	process.env.OMP_USAGE_LEDGER_DB = path.join(tempDir, "usage-ledger.db");
	closeLedger();
});

afterEach(async () => {
	closeLedger();
	if (originalEnv === undefined) {
		delete process.env.OMP_USAGE_LEDGER_DB;
	} else {
		process.env.OMP_USAGE_LEDGER_DB = originalEnv;
	}
	await removeWithRetries(tempDir);
});

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
	return {
		recordedAt: 1_000,
		project: "alpha",
		sessionId: "s1",
		model: "claude-opus-4-5",
		provider: "anthropic",
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 10,
		cacheWriteTokens: 5,
		costUsd: 0.1,
		...overrides,
	};
}

/** Two projects, three sessions, two model/provider pairs. */
function seedFixture(): void {
	recordLedgerEntry(entry());
	recordLedgerEntry(
		entry({
			recordedAt: 2_000,
			inputTokens: 200,
			outputTokens: 60,
			cacheReadTokens: 20,
			cacheWriteTokens: 0,
			costUsd: 0.2,
		}),
	);
	recordLedgerEntry(
		entry({
			recordedAt: 3_000,
			sessionId: "s2",
			model: "gpt-5",
			provider: "openai",
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.01,
		}),
	);
	recordLedgerEntry(
		entry({
			recordedAt: 4_000,
			project: "beta",
			sessionId: "s3",
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.9,
		}),
	);
}

describe("cost ledger", () => {
	it("round-trips appends and aggregates totals per project, most expensive first", () => {
		seedFixture();

		const totals = queryProjectTotals();

		expect(totals.map(row => row.project)).toEqual(["beta", "alpha"]);
		const [beta, alpha] = totals;
		expect(alpha).toBeDefined();
		expect(beta).toBeDefined();
		if (!alpha || !beta) return;

		expect(alpha.costUsd).toBeCloseTo(0.31, 10);
		expect(alpha.inputTokens).toBe(310);
		expect(alpha.outputTokens).toBe(115);
		expect(alpha.cacheReadTokens).toBe(30);
		expect(alpha.cacheWriteTokens).toBe(5);
		expect(alpha.totalTokens).toBe(460);
		expect(alpha.sessions).toBe(2);
		expect(alpha.firstRecordedAt).toBe(1_000);
		expect(alpha.lastRecordedAt).toBe(3_000);

		expect(beta.costUsd).toBeCloseTo(0.9, 10);
		expect(beta.totalTokens).toBe(2);
		expect(beta.sessions).toBe(1);
		expect(beta.firstRecordedAt).toBe(4_000);
		expect(beta.lastRecordedAt).toBe(4_000);
	});

	it("narrows to one project when `project` is supplied", () => {
		seedFixture();

		const totals = queryProjectTotals({ project: "alpha" });

		expect(totals).toHaveLength(1);
		expect(totals[0]?.project).toBe("alpha");
		expect(totals[0]?.totalTokens).toBe(460);
	});

	it("applies `since` as an inclusive epoch-ms lower bound", () => {
		seedFixture();

		const totals = queryProjectTotals({ since: 2_000 });
		const alpha = totals.find(row => row.project === "alpha");

		expect(alpha).toBeDefined();
		// Only the 2000ms and 3000ms rows survive; the 1000ms row is excluded.
		expect(alpha?.costUsd).toBeCloseTo(0.21, 10);
		expect(alpha?.totalTokens).toBe(295);
		expect(alpha?.firstRecordedAt).toBe(2_000);

		// A cutoff past every row leaves nothing to group.
		expect(queryProjectTotals({ since: 5_000 })).toEqual([]);
	});

	it("counts distinct sessions and ignores entries with no session id", () => {
		recordLedgerEntry(entry({ project: "gamma", sessionId: "s9", recordedAt: 10 }));
		recordLedgerEntry(entry({ project: "gamma", sessionId: "s9", recordedAt: 20 }));
		recordLedgerEntry(entry({ project: "gamma", sessionId: undefined, recordedAt: 30 }));

		const totals = queryProjectTotals({ project: "gamma" });

		expect(totals[0]?.sessions).toBe(1);
		// The session-less row still contributes its tokens and cost.
		expect(totals[0]?.totalTokens).toBe(495);
	});

	it("groups model totals by model and provider, most expensive first", () => {
		seedFixture();

		const totals = queryModelTotals();

		expect(totals).toEqual([
			{
				model: "claude-opus-4-5",
				provider: "anthropic",
				costUsd: expect.any(Number),
				totalTokens: 447,
				requests: 3,
			},
			{ model: "gpt-5", provider: "openai", costUsd: expect.any(Number), totalTokens: 15, requests: 1 },
		]);
		expect(totals[0]?.costUsd).toBeCloseTo(1.2, 10);
		expect(totals[1]?.costUsd).toBeCloseTo(0.01, 10);
	});

	it("honors the project and since filters in model totals", () => {
		seedFixture();

		const totals = queryModelTotals({ project: "alpha", since: 3_000 });

		expect(totals).toHaveLength(1);
		expect(totals[0]?.model).toBe("gpt-5");
		expect(totals[0]?.requests).toBe(1);
	});

	it("skips entries with neither cost nor tokens, but keeps free token-bearing turns", () => {
		recordLedgerEntry(
			entry({
				project: "empty",
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0,
			}),
		);
		recordLedgerEntry(
			entry({
				project: "free",
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 42,
				cacheWriteTokens: 0,
				costUsd: 0,
			}),
		);

		expect(queryProjectTotals().map(row => row.project)).toEqual(["free"]);
		expect(queryProjectTotals({ project: "free" })[0]?.totalTokens).toBe(42);
	});

	it("degrades silently when the ledger path cannot be opened", async () => {
		// A regular file where a directory is required: mkdir and sqlite open
		// both fail regardless of the effective uid.
		const blocker = path.join(tempDir, "not-a-directory");
		await fs.writeFile(blocker, "x");
		process.env.OMP_USAGE_LEDGER_DB = path.join(blocker, "usage-ledger.db");
		closeLedger();

		expect(() => recordLedgerEntry(entry())).not.toThrow();
		expect(queryProjectTotals()).toEqual([]);
		expect(queryModelTotals()).toEqual([]);
		expect(() => closeLedger()).not.toThrow();
	});

	it("does not retry a failed open until the ledger is closed", async () => {
		const blocker = path.join(tempDir, "blocker-file");
		await fs.writeFile(blocker, "x");
		process.env.OMP_USAGE_LEDGER_DB = path.join(blocker, "usage-ledger.db");
		closeLedger();
		recordLedgerEntry(entry());

		// Path is healthy again, but the latch keeps the connection disabled so
		// a broken config cannot re-attempt on every assistant message.
		const healthy = path.join(tempDir, "healthy.db");
		process.env.OMP_USAGE_LEDGER_DB = healthy;
		recordLedgerEntry(entry({ project: "still-disabled" }));
		expect(queryProjectTotals()).toEqual([]);

		// closeLedger() re-arms lazy open.
		closeLedger();
		recordLedgerEntry(entry({ project: "recovered" }));
		expect(queryProjectTotals().map(row => row.project)).toEqual(["recovered"]);
	});
});
