#!/usr/bin/env bun
/**
 * Test fixture: a scripted stdio MCP server that mimics the Python
 * `mempalace.mcp_server` wire behavior closely enough to pin
 * `MempalaceTransport` without any Python in the loop.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of `StdioTransport`):
 * one JSON object per line on stdin, one JSON response per line on stdout.
 * Only requests (objects with an `id`) get a response; notifications are
 * dropped. Same shape as `instructions-mcp.ts` / `delayed-tool-mcp.ts`.
 *
 * Modelled mempalace behaviors:
 * - tools answer with a single text content block holding a JSON string;
 * - domain failures use `"success": false` + `error` in that JSON, with
 *   `isError` left off — they are successful MCP calls carrying a failure;
 * - a slow tool for exercising per-call request timeouts;
 * - `--exit-on-init` (or `MEMPALACE_FIXTURE_EXIT_ON_INIT=1`) makes the server
 *   die while handling `initialize`, modelling a server that fails to start.
 *
 * Exported constants are imported by the test; the server only starts when run
 * as the entry module (`import.meta.main`), so importing them never spawns it.
 */
import * as readline from "node:readline";

/** Tool returning a mempalace-style success payload. */
export const HAPPY_TOOL = "mempalace_status";
/** Tool returning a mempalace-style domain failure payload. */
export const DOMAIN_ERROR_TOOL = "mempalace_add_drawer";
/** Tool that sleeps past any short request timeout before answering. */
export const SLOW_TOOL = "mempalace_search";

export const TOOL_NAMES = [HAPPY_TOOL, DOMAIN_ERROR_TOOL, SLOW_TOOL];

/** JSON text returned by `HAPPY_TOOL`. */
export const HAPPY_PAYLOAD = JSON.stringify({ success: true, palace: "fixture", wings: 3 });
/** `error` field the transport must surface for `DOMAIN_ERROR_TOOL`. */
export const DOMAIN_ERROR_MESSAGE = "wing 'nope' does not exist";
/** JSON text returned by `DOMAIN_ERROR_TOOL`. */
export const DOMAIN_ERROR_PAYLOAD = JSON.stringify({ success: false, error: DOMAIN_ERROR_MESSAGE });

/** How long `SLOW_TOOL` sleeps before answering. */
export const SLOW_TOOL_DELAY_MS = 1500;

/** Argv flag / env var that make the server die during `initialize`. */
export const EXIT_ON_INIT_FLAG = "--exit-on-init";
export const EXIT_ON_INIT_ENV = "MEMPALACE_FIXTURE_EXIT_ON_INIT";

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: { name?: string; arguments?: Record<string, unknown> };
};

function textResult(text: string): Record<string, unknown> {
	return { content: [{ type: "text", text }], isError: false };
}

function buildToolResult(toolName: string | undefined): Record<string, unknown> {
	switch (toolName) {
		case HAPPY_TOOL:
			return textResult(HAPPY_PAYLOAD);
		case DOMAIN_ERROR_TOOL:
			// mempalace reports domain failures inside a successful MCP call.
			return textResult(DOMAIN_ERROR_PAYLOAD);
		case SLOW_TOOL:
			return textResult(JSON.stringify({ success: true, results: [] }));
		default:
			return {
				content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
				isError: true,
			};
	}
}

function buildResult(msg: JsonRpcRequest): Record<string, unknown> {
	switch (msg.method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "mempalace-fixture", version: "3.6.0" },
				// Only tools — keeps the client from probing resources/prompts.
				capabilities: { tools: {} },
			};
		case "tools/list":
			return {
				tools: TOOL_NAMES.map(name => ({
					name,
					description: `Fixture stand-in for ${name}.`,
					inputSchema: { type: "object", properties: {}, additionalProperties: true },
				})),
			};
		case "tools/call":
			return buildToolResult(msg.params?.name);
		default:
			// `ping` and anything else the client may probe.
			return {};
	}
}

function startServer(): void {
	const exitOnInit = process.argv.includes(EXIT_ON_INIT_FLAG) || process.env[EXIT_ON_INIT_ENV] === "1";
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		void (async () => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return;
			let msg: JsonRpcRequest;
			try {
				msg = JSON.parse(trimmed) as JsonRpcRequest;
			} catch {
				return;
			}
			if (msg.id === undefined || msg.id === null) return;
			if (msg.method === "initialize" && exitOnInit) {
				// Die without answering: the client sees EOF mid-handshake.
				process.exit(1);
			}
			if (msg.method === "tools/call" && msg.params?.name === SLOW_TOOL) {
				await Bun.sleep(SLOW_TOOL_DELAY_MS);
			}
			const response = { jsonrpc: "2.0" as const, id: msg.id, result: buildResult(msg) };
			try {
				process.stdout.write(`${JSON.stringify(response)}\n`);
			} catch {
				// Client hung up (timed-out call) — nothing to report to.
			}
		})();
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
