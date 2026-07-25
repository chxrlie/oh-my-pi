import { describe, expect, it } from "bun:test";
import {
	isJSOrTSCode,
	isJSOrTSPath,
	isMinipackCompressed,
	minifyJSTS,
	minipackCompress,
	minipackDecompress,
} from "@oh-my-pi/pi-utils/minipack";

describe("minipack JS/TS compression", () => {
	it("identifies JS and TS file paths", () => {
		expect(isJSOrTSPath("src/index.ts")).toBe(true);
		expect(isJSOrTSPath("components/App.tsx")).toBe(true);
		expect(isJSOrTSPath("lib/utils.js")).toBe(true);
		expect(isJSOrTSPath("module.mjs")).toBe(true);
		expect(isJSOrTSPath("readme.md")).toBe(false);
		expect(isJSOrTSPath("data.json")).toBe(false);
		expect(isJSOrTSPath("script.py")).toBe(false);
	});

	it("detects JS/TS code heuristics", () => {
		expect(isJSOrTSCode("import { x } from 'y';")).toBe(true);
		expect(isJSOrTSCode("export const a = 1;")).toBe(true);
		expect(isJSOrTSCode("function add(a, b) { return a + b; }")).toBe(true);
		expect(isJSOrTSCode("This is plain text with no code")).toBe(false);
	});

	it("strips comments and optimizes whitespace in JS/TS code", () => {
		const input = `
            // This is a single line comment
            function compute(x: number, y: number): number {
                /* Multi-line comment
                   spanning multiple lines */
                const result = x + y; // calculate sum
                return result;
            }
        `;
		const minified = minifyJSTS(input);
		expect(minified).not.toContain("single line comment");
		expect(minified).not.toContain("Multi-line comment");
		expect(minified).toContain("function compute");
		expect(minified).toContain("return result;");
	});

	it("preserves string literals and comments inside strings", () => {
		const input = `const message = "Hello // not a comment /* also not comment */";`;
		const minified = minifyJSTS(input);
		expect(minified).toContain('"Hello // not a comment /* also not comment */"');
	});

	it("preserves template literals and string interpolation", () => {
		const input = "const msg = `Value: ${val /* inner comment */}`;";
		const minified = minifyJSTS(input);
		expect(minified).toContain("Value: ${val}");
	});

	it("losslessly compresses and decompresses JS/TS code verbatim", () => {
		const original = `
import { Database } from "bun:sqlite";
import * as path from "node:path";

/**
 * Service class for processing user analytics data.
 * Handles database operations and session tracking.
 */
export class AnalyticsService {
    private db: Database;

    constructor(dbPath: string) {
        // Initialize SQLite connection
        this.db = new Database(dbPath);
    }

    public async trackEvent(userId: string, eventName: string, metadata: Record<string, unknown>): Promise<boolean> {
        /* Record event payload to analytics log table */
        const timestamp = Date.now();
        const payload = JSON.stringify(metadata);
        
        const stmt = this.db.prepare("INSERT INTO events (user_id, event_name, payload, timestamp) VALUES (?, ?, ?, ?)");
        stmt.run(userId, eventName, payload, timestamp);

        return true;
    }
}
        `;

		const compressedRes = minipackCompress(original, { force: true });
		expect(compressedRes.compressed).toBe(true);
		expect(isMinipackCompressed(compressedRes.code)).toBe(true);
		expect(compressedRes.code).toContain("--- MINIPACK LOSSLESS RECOVERY FOOTER ---");

		const recovered = minipackDecompress(compressedRes.code);
		expect(recovered).toBe(original);
	});

	it("bypasses compression for non-JS/TS files unless forced", () => {
		const plainText = "Line 1\nLine 2\nLine 3\nLine 4\n";
		const res = minipackCompress(plainText, { path: "notes.txt" });
		expect(res.compressed).toBe(false);
		expect(res.code).toBe(plainText);
	});
});
