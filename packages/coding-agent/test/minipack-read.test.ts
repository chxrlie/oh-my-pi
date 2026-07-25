import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { minipackDecompress, removeWithRetries } from "@oh-my-pi/pi-utils";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

function createSession(cwd: string, overrides: Record<string, unknown> = {}): ToolSession {
	const settings = Settings.isolated({
		"read.summarize.enabled": false, // disable tree-sitter summary so full file text goes to read output
		"read.minipack.enabled": true,
		"read.minipack.tokenThreshold": 100, // lower threshold for fast test execution
		...overrides,
	});
	return {
		cwd,
		settings,
		getSessionId: () => "test-session",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
	} as unknown as ToolSession;
}

describe("minipack read tool integration & contract tests", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "minipack-read-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("compresses large JS/TS file reads losslessly with recovery footer", async () => {
		const session = createSession(tmpDir, { "read.minipack.tokenThreshold": 50 });
		const readTool = new ReadTool(session);

		const largeCode = `
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Enterprise Service Manager for handling customer data synchronization.
 * Supports automated retry, rate limiting, and transactional rollbacks.
 */
export class EnterpriseSyncManager {
    private db: Database;
    private isRunning = false;

    constructor(private readonly connectionString: string) {
        // Connect to primary SQLite database
        this.db = new Database(connectionString);
    }

    /*
     * Synchronize customer records across regional node endpoints.
     * Retries up to 3 times on transient network failures.
     */
    public async syncCustomers(regionId: string, records: Array<Record<string, unknown>>): Promise<{ synced: number; failed: number }> {
        let synced = 0;
        let failed = 0;

        for (const record of records) {
            try {
                // Process single customer record payload
                const recordId = String(record.id ?? "unknown");
                const payload = JSON.stringify(record);

                const stmt = this.db.prepare("INSERT OR REPLACE INTO customer_sync (region_id, record_id, payload, synced_at) VALUES (?, ?, ?, ?)");
                stmt.run(regionId, recordId, payload, Date.now());
                synced++;
            } catch (err) {
                // Log failed sync entry
                console.error("Sync failed for record:", record, err);
                failed++;
            }
        }

        return { synced, failed };
    }
}
        `.repeat(5);

		const filePath = path.join(tmpDir, "sync-service.ts");
		await fs.writeFile(filePath, largeCode, "utf-8");

		const result = await readTool.execute("read-1", { path: "sync-service.ts" });
		const outText = textOutput(result);

		expect(outText).toContain("--- MINIPACK LOSSLESS RECOVERY FOOTER ---");
		expect(outText).toContain("[MINIPACK:v1:");
		expect(result.details?.minipack).toBeDefined();
		expect(result.details?.minipack?.originalTokens).toBeGreaterThan(0);
		expect(result.details?.minipack?.compressedTokens).toBeLessThan(result.details?.minipack?.originalTokens ?? 0);

		// Verify 100% lossless verbatim decompression contract
		const decompressed = minipackDecompress(outText);
		expect(decompressed).toBe(largeCode);
	});

	it("skips minipack compression when file is below token threshold", async () => {
		const session = createSession(tmpDir, { "read.minipack.tokenThreshold": 10000 });
		const readTool = new ReadTool(session);

		const shortCode = "const x = 1;\nconst y = 2;\n";
		const filePath = path.join(tmpDir, "short.ts");
		await fs.writeFile(filePath, shortCode, "utf-8");

		const result = await readTool.execute("read-2", { path: "short.ts" });
		const outText = textOutput(result);

		expect(outText).not.toContain("MINIPACK LOSSLESS RECOVERY FOOTER");
		expect(result.details?.minipack).toBeUndefined();
	});

	it("bypasses minipack compression when :raw selector is requested", async () => {
		const session = createSession(tmpDir, { "read.minipack.tokenThreshold": 10 });
		const readTool = new ReadTool(session);

		const code = "// Comment line 1\nconst a = 1;\n// Comment line 2\nconst b = 2;\n".repeat(20);
		const filePath = path.join(tmpDir, "raw-test.ts");
		await fs.writeFile(filePath, code, "utf-8");

		const result = await readTool.execute("read-3", { path: "raw-test.ts:raw" });
		const outText = textOutput(result);

		expect(outText).not.toContain("MINIPACK LOSSLESS RECOVERY FOOTER");
		expect(outText).toBe(code);
	});

	it("respects read.minipack.enabled setting when set to false", async () => {
		const session = createSession(tmpDir, { "read.minipack.enabled": false, "read.minipack.tokenThreshold": 10 });
		const readTool = new ReadTool(session);

		const code = "// Comment line 1\nconst a = 1;\n// Comment line 2\nconst b = 2;\n".repeat(20);
		const filePath = path.join(tmpDir, "disabled-test.ts");
		await fs.writeFile(filePath, code, "utf-8");

		const result = await readTool.execute("read-4", { path: "disabled-test.ts" });
		const outText = textOutput(result);

		expect(outText).not.toContain("MINIPACK LOSSLESS RECOVERY FOOTER");
		expect(result.details?.minipack).toBeUndefined();
	});
});
