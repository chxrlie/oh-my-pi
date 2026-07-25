import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { MempalaceTransport } from "@oh-my-pi/pi-coding-agent/mempalace/transport";
import {
	DOMAIN_ERROR_MESSAGE,
	DOMAIN_ERROR_TOOL,
	EXIT_ON_INIT_FLAG,
	HAPPY_PAYLOAD,
	HAPPY_TOOL,
	SLOW_TOOL,
	TOOL_NAMES,
} from "./fixtures/mempalace-mcp";

/**
 * Hermetic pins for the mempalace MCP adapter: the scripted fixture stands in
 * for `python -m mempalace.mcp_server`, so nothing here needs Python.
 *
 * The hard gate under test is totality — a broken or absent server must show
 * up as `ok: false`, never as a thrown error or an unhandled rejection.
 */
const FIXTURE = path.join(import.meta.dir, "fixtures", "mempalace-mcp.ts");
const BUN_EXEC = process.execPath;

const open: MempalaceTransport[] = [];

function makeTransport(opts?: {
	requestTimeoutMs?: number;
	connectTimeoutMs?: number;
	serverArgs?: string[];
	command?: string;
}): MempalaceTransport {
	const transport = new MempalaceTransport({
		// `command` overrides the probe's Python launcher — the fixture is a bun script.
		pythonCommand: "python3",
		command: opts?.command ?? BUN_EXEC,
		serverArgs: opts?.serverArgs ?? [FIXTURE],
		connectTimeoutMs: opts?.connectTimeoutMs ?? 5_000,
		...(opts?.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: opts.requestTimeoutMs }),
	});
	open.push(transport);
	return transport;
}

afterEach(async () => {
	for (const transport of open.splice(0)) {
		await transport.close();
	}
});

describe("MempalaceTransport", () => {
	it("connects and returns the tool's text payload on success", async () => {
		const transport = makeTransport();

		await transport.connect();
		expect(transport.connected).toBe(true);

		const result = await transport.callTool(HAPPY_TOOL, {});

		expect(result.ok).toBe(true);
		expect(result.via).toBe("mcp");
		expect(result.text).toBe(HAPPY_PAYLOAD);
		expect(result.error).toBeUndefined();
	});

	it("connects lazily on the first call", async () => {
		const transport = makeTransport();

		expect(transport.connected).toBe(false);
		const result = await transport.callTool(HAPPY_TOOL, {});

		expect(result.ok).toBe(true);
		expect(transport.connected).toBe(true);
	});

	it("treats a `success: false` JSON payload as a failed call and surfaces its error", async () => {
		const transport = makeTransport();

		const result = await transport.callTool(DOMAIN_ERROR_TOOL, { wing: "nope", room: "r", content: "c" });

		expect(result.ok).toBe(false);
		expect(result.error).toBe(DOMAIN_ERROR_MESSAGE);
		// The raw payload is still handed back for callers that want detail.
		expect(result.text).toContain(DOMAIN_ERROR_MESSAGE);
		expect(result.via).toBe("mcp");
	});

	it("fails the call when the request timeout elapses", async () => {
		const transport = makeTransport({ requestTimeoutMs: 150 });

		const result = await transport.callTool(SLOW_TOOL, { query: "anything" });

		expect(result.ok).toBe(false);
		expect(result.error).toContain("timed out");
		expect(result.via).toBe("mcp");
	});

	it("honors a per-call timeout override", async () => {
		const transport = makeTransport({ requestTimeoutMs: 10_000 });

		const result = await transport.callTool(SLOW_TOOL, { query: "anything" }, { timeoutMs: 150 });

		expect(result.ok).toBe(false);
		expect(result.error).toContain("timed out");
	});

	it("takes the request timeout from MEMPALACE_MCP_REQUEST_TIMEOUT_MS when unset", async () => {
		const previous = Bun.env.MEMPALACE_MCP_REQUEST_TIMEOUT_MS;
		Bun.env.MEMPALACE_MCP_REQUEST_TIMEOUT_MS = "150";
		try {
			const result = await makeTransport().callTool(SLOW_TOOL, { query: "anything" });

			expect(result.ok).toBe(false);
			expect(result.error).toContain("150ms");
		} finally {
			if (previous === undefined) {
				delete Bun.env.MEMPALACE_MCP_REQUEST_TIMEOUT_MS;
			} else {
				Bun.env.MEMPALACE_MCP_REQUEST_TIMEOUT_MS = previous;
			}
		}
	});

	it("degrades instead of throwing when the server dies during startup", async () => {
		const transport = makeTransport({ serverArgs: [FIXTURE, EXIT_ON_INIT_FLAG], connectTimeoutMs: 3_000 });

		// Must resolve, never reject.
		await transport.connect();
		expect(transport.connected).toBe(false);

		const result = await transport.callTool(HAPPY_TOOL, {});
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
		expect(result.text).toBe("");
		expect(result.via).toBe("mcp");
	});

	it("degrades instead of throwing when the command does not exist", async () => {
		const transport = makeTransport({
			command: "omp-mempalace-missing-binary-9f31",
			serverArgs: ["-m", "mempalace.mcp_server"],
			connectTimeoutMs: 3_000,
		});

		await transport.connect();
		expect(transport.connected).toBe(false);

		const result = await transport.callTool(HAPPY_TOOL, {});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("omp-mempalace-missing-binary-9f31");
		expect(await transport.listToolNames()).toEqual([]);
	});

	it("lists the server's tool names", async () => {
		const transport = makeTransport();

		expect(await transport.listToolNames()).toEqual(TOOL_NAMES);
	});

	it("closes idempotently and can reconnect afterwards", async () => {
		const transport = makeTransport();

		await transport.connect();
		await transport.close();
		expect(transport.connected).toBe(false);
		// Second close is a no-op, not a throw.
		await transport.close();
		expect(transport.connected).toBe(false);

		const result = await transport.callTool(HAPPY_TOOL, {});
		expect(result.ok).toBe(true);
	});

	it("closes cleanly without ever having connected", async () => {
		const transport = makeTransport();

		await transport.close();
		expect(transport.connected).toBe(false);
	});
});
