import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	MemoryBackendOperationContext,
	MemoryBackendStartOptions,
} from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import {
	deriveWing,
	type MempalaceSessionStateFactoryOptions,
	type MempalaceSessionStateLike,
	type MempalaceTransportLike,
	mempalaceBackend,
	setMempalaceDepsForTests,
} from "@oh-my-pi/pi-coding-agent/mempalace/backend";
import type { CliRunResult } from "@oh-my-pi/pi-coding-agent/mempalace/cli";
import type { IngestTarget, MempalaceCallResult, MempalaceProbe } from "@oh-my-pi/pi-coding-agent/mempalace/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/**
 * Hermetic contract pins for the MemPalace backend.
 *
 * Every external edge — the Python probe, the MCP transport, the CLI runner and
 * the session-state cadence — is injected, so nothing here needs Python. The
 * behaviour under test is what a caller can observe: transport precedence
 * (MCP → CLI), degradation when mempalace is absent, tool argument shape, and
 * the promise that no entrypoint throws.
 */

const AGENT_DIR = "/tmp/omp-mempalace/agent";
const PROJECT_DIR = "/tmp/omp-mempalace/My Project";
const SESSION_DIR = "/tmp/omp-mempalace/sessions";

const INSTALLED_PROBE: MempalaceProbe = { pythonCommand: "python3", installed: true, version: "3.6.0" };
const MISSING_PROBE: MempalaceProbe = {
	pythonCommand: undefined,
	installed: false,
	detail: "no python3/python interpreter on PATH",
};

class FakeTransport implements MempalaceTransportLike {
	connected = false;
	failConnect = false;
	closes = 0;
	tools: string[] = ["mempalace_search", "mempalace_add_drawer"];
	readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	readonly responses = new Map<string, MempalaceCallResult>();

	async connect(): Promise<void> {
		this.connected = !this.failConnect;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<MempalaceCallResult> {
		this.calls.push({ name, args });
		await this.connect();
		if (!this.connected) return { ok: false, text: "", error: "MemPalace MCP server is not connected", via: "mcp" };
		return this.responses.get(name) ?? { ok: false, text: "", error: `unscripted tool ${name}`, via: "mcp" };
	}

	async listToolNames(): Promise<string[]> {
		return this.tools;
	}

	async close(): Promise<void> {
		this.closes++;
		this.connected = false;
	}

	script(name: string, text: string): void {
		this.responses.set(name, { ok: true, text, via: "mcp" });
	}
}

class FakeState implements MempalaceSessionStateLike {
	attached = 0;
	detached = 0;
	imported = 0;

	constructor(readonly options: MempalaceSessionStateFactoryOptions) {}

	attach(): void {
		this.attached++;
	}

	detach(): void {
		this.detached++;
	}

	async maybeImportLocalMemories(): Promise<void> {
		this.imported++;
	}
}

interface CliCall {
	args: string[];
	cwd?: string;
	timeoutMs?: number;
}

let probe: MempalaceProbe;
let transport: FakeTransport;
let states: FakeState[];
let cliCalls: CliCall[];
let cliScript: Map<string, CliRunResult>;
let cliDefault: CliRunResult;
let createSessionStateError: Error | undefined;

function cliResult(exitCode: number, stdout = "", stderr = ""): CliRunResult {
	return { exitCode, stdout, stderr, command: ["python3", "-m", "mempalace"] };
}

async function installDeps(): Promise<void> {
	transport = new FakeTransport();
	states = [];
	cliCalls = [];
	cliScript = new Map();
	cliDefault = cliResult(127, "", "mempalace CLI not found");
	createSessionStateError = undefined;

	await setMempalaceDepsForTests({
		probe: async () => probe,
		createTransport: () => transport,
		runCli: async (args, opts) => {
			cliCalls.push({ args, cwd: opts?.cwd, timeoutMs: opts?.timeoutMs });
			return cliScript.get(args[0] ?? "") ?? cliDefault;
		},
		createSessionState: options => {
			if (createSessionStateError) throw createSessionStateError;
			const state = new FakeState(options);
			states.push(state);
			return state;
		},
		sessionsDir: () => SESSION_DIR,
	});
}

const SETTINGS: Record<string, unknown> = {
	"mempalace.connectTimeoutMs": 30000,
	"mempalace.requestTimeoutMs": 30000,
	"mempalace.ingestIntervalMessages": 15,
	"mempalace.autoIngest": true,
	"mempalace.importLocalMemories": false,
};

function fakeSession(opts?: { cwd?: string; sessionFile?: string }): AgentSession {
	return {
		settings: { get: (key: string) => SETTINGS[key] } as unknown as Settings,
		sessionFile: opts?.sessionFile,
		sessionManager: { getCwd: () => opts?.cwd ?? PROJECT_DIR },
	} as unknown as AgentSession;
}

function context(session?: AgentSession): MemoryBackendOperationContext {
	return { agentDir: AGENT_DIR, cwd: PROJECT_DIR, session };
}

function startOptions(session: AgentSession, taskDepth = 0): MemoryBackendStartOptions {
	return {
		session,
		settings: session.settings,
		modelRegistry: {},
		agentDir: AGENT_DIR,
		taskDepth,
	} as unknown as MemoryBackendStartOptions;
}

const SEARCH_PAYLOAD = JSON.stringify({
	query: "grid overlay",
	filters: { wing: null, room: null, source_file: null },
	total_before_filter: 2,
	results: [
		{
			text: "subgrid columns must be measured, not assumed",
			wing: "my_project",
			room: "decisions",
			source_file: "notes.md",
			source_path: "/tmp/omp-mempalace/My Project/notes.md",
			created_at: "2026-07-01T10:00:00",
			authored_at: "2026-07-02T11:00:00",
			similarity: 0.82,
		},
		{
			text: "baseline lock is 8px",
			wing: "my_project",
			room: "decisions",
			source_file: "?",
			source_path: "",
			created_at: "unknown",
			authored_at: "unknown",
			similarity: 0.44,
		},
	],
});

let savedEnv: { mempalace?: string; legacy?: string };

beforeEach(async () => {
	savedEnv = { mempalace: process.env.MEMPALACE_DIR, legacy: process.env.MEMPAL_DIR };
	delete process.env.MEMPALACE_DIR;
	delete process.env.MEMPAL_DIR;
	probe = INSTALLED_PROBE;
	await installDeps();
});

afterEach(async () => {
	// Restore the real dependencies so no other suite inherits the fakes.
	await setMempalaceDepsForTests();
	if (savedEnv.mempalace === undefined) delete process.env.MEMPALACE_DIR;
	else process.env.MEMPALACE_DIR = savedEnv.mempalace;
	if (savedEnv.legacy === undefined) delete process.env.MEMPAL_DIR;
	else process.env.MEMPAL_DIR = savedEnv.legacy;
});

describe("mempalaceBackend without Python or the mempalace package", () => {
	beforeEach(async () => {
		probe = MISSING_PROBE;
		await installDeps();
	});

	it("reports an install hint instead of pretending to be active", async () => {
		const status = await mempalaceBackend.status!(context(fakeSession()));

		expect(status.backend).toBe("mempalace");
		expect(status.active).toBe(false);
		expect(status.writable).toBe(false);
		expect(status.searchable).toBe(false);
		expect(status.message).toContain("pip install mempalace");
		expect(status.error).toBe(MISSING_PROBE.detail);
	});

	it("starts inert: no transport, no session cadence, no throw", async () => {
		const session = fakeSession();

		await mempalaceBackend.start(startOptions(session));

		expect(states).toHaveLength(0);
		expect(transport.calls).toHaveLength(0);
		expect(transport.connected).toBe(false);
	});

	it("injects no system-prompt section", async () => {
		const session = fakeSession();

		expect(await mempalaceBackend.buildDeveloperInstructions(AGENT_DIR, session.settings, session)).toBeUndefined();
	});

	it("degrades every entrypoint instead of throwing", async () => {
		const session = fakeSession();

		const search = await mempalaceBackend.search!(context(session), "anything");
		expect(search.count).toBe(0);
		expect(search.items).toEqual([]);
		expect(search.message).toContain("failed");

		const save = await mempalaceBackend.save!(context(session), { content: "a fact" });
		expect(save.stored).toBe(0);
		expect(save.message).toContain("pip install mempalace");

		await mempalaceBackend.clear(AGENT_DIR, PROJECT_DIR, session);
		await mempalaceBackend.enqueue(AGENT_DIR, PROJECT_DIR, session);
		// enqueue must not shell out when the package is known to be missing.
		expect(cliCalls.filter(call => call.args[0] === "mine")).toHaveLength(0);

		expect(await mempalaceBackend.preCompactionContext!([], session.settings, session)).toBeUndefined();
	});
});

describe("mempalaceBackend.start", () => {
	it("attaches session cadence, warms the transport, and imports local memories", async () => {
		const session = fakeSession();

		// start() kicks off the import synchronously, so awaiting start() is enough.
		await mempalaceBackend.start(startOptions(session));

		expect(states).toHaveLength(1);
		expect(states[0].attached).toBe(1);
		expect(states[0].imported).toBe(1);
		expect(states[0].options.agentDir).toBe(AGENT_DIR);
		expect(transport.connected).toBe(true);
	});

	it("skips cadence for subagents so one palace is not mined twice per interval", async () => {
		const session = fakeSession();

		await mempalaceBackend.start(startOptions(session, 1));

		expect(states).toHaveLength(0);
		expect(transport.connected).toBe(true);
	});

	it("swallows a session-state construction failure", async () => {
		createSessionStateError = new Error("state exploded");
		const session = fakeSession();

		await mempalaceBackend.start(startOptions(session));

		expect(states).toHaveLength(0);
	});

	it("routes the cadence callback to `mempalace mine <dir> --mode convos`", async () => {
		cliScript.set("mine", cliResult(0, "mined 12 files"));
		const session = fakeSession();
		await mempalaceBackend.start(startOptions(session));

		const target: IngestTarget = { dir: SESSION_DIR, source: "session" };
		const result = await states[0].options.runIngest(target);

		expect(result.exitCode).toBe(0);
		expect(cliCalls.at(-1)?.args).toEqual(["mine", SESSION_DIR, "--mode", "convos"]);
	});

	it("mines a session-log subdirectory as convos even when the target is not `source: session`", async () => {
		cliScript.set("mine", cliResult(0, "mined 12 files"));
		const session = fakeSession();
		await mempalaceBackend.start(startOptions(session));

		const nested = `${SESSION_DIR}/-Projects-foo`;
		const target: IngestTarget = { dir: nested, source: "cwd" };
		await states[0].options.runIngest(target);

		expect(cliCalls.at(-1)?.args).toEqual(["mine", nested, "--mode", "convos"]);
	});
});

describe("mempalaceBackend.search", () => {
	it("maps an MCP payload onto backend search items", async () => {
		transport.script("mempalace_search", SEARCH_PAYLOAD);

		const result = await mempalaceBackend.search!(context(fakeSession()), "grid overlay", { limit: 5 });

		expect(result.backend).toBe("mempalace");
		expect(result.count).toBe(2);
		expect(result.message).toBeUndefined();
		expect(result.items[0]).toEqual({
			content: "subgrid columns must be measured, not assumed",
			source: "/tmp/omp-mempalace/My Project/notes.md",
			timestamp: "2026-07-02T11:00:00",
			score: 0.82,
		});
		// "unknown"/"?" placeholders are dropped; the wing/room pair stands in.
		expect(result.items[1]).toEqual({
			content: "baseline lock is 8px",
			source: "my_project/decisions",
			score: 0.44,
		});
		expect(transport.calls[0]).toEqual({ name: "mempalace_search", args: { query: "grid overlay", limit: 5 } });
		expect(cliCalls).toHaveLength(0);
	});

	it("honours the caller's limit when the server over-returns", async () => {
		transport.script("mempalace_search", SEARCH_PAYLOAD);

		const result = await mempalaceBackend.search!(context(fakeSession()), "grid overlay", { limit: 1 });

		expect(result.count).toBe(1);
		expect(transport.calls[0].args.limit).toBe(1);
	});

	it("falls back to the CLI with --results when MCP is unavailable", async () => {
		transport.failConnect = true;
		cliScript.set("search", cliResult(0, "1. baseline lock is 8px\n   my_project/decisions"));

		const result = await mempalaceBackend.search!(context(fakeSession()), "baseline", { limit: 3 });

		expect(cliCalls[0]?.args).toEqual(["search", "baseline", "--results", "3"]);
		expect(cliCalls[0]?.cwd).toBe(PROJECT_DIR);
		expect(result.count).toBe(1);
		expect(result.items[0].source).toBe("mempalace-cli");
		expect(result.items[0].content).toContain("baseline lock is 8px");
		expect(result.message).toContain("CLI");
	});

	it("reports both transports when MCP and the CLI fail", async () => {
		transport.failConnect = true;
		cliScript.set("search", cliResult(2, "", "no palace found"));

		const result = await mempalaceBackend.search!(context(fakeSession()), "baseline");

		expect(result.count).toBe(0);
		expect(result.items).toEqual([]);
		expect(result.message).toContain("not connected");
		expect(result.message).toContain("no palace found");
	});

	it("stops after the breaker trips instead of re-running a broken CLI", async () => {
		transport.failConnect = true;
		cliScript.set("search", cliResult(2, "", "no palace found"));
		const session = fakeSession();

		for (let attempt = 0; attempt < 5; attempt++) {
			await mempalaceBackend.search!(context(session), `q${attempt}`);
		}

		// Default breaker threshold is 3 consecutive failures, 60s cooldown.
		expect(cliCalls).toHaveLength(3);
	});

	it("short-circuits an aborted search without touching either transport", async () => {
		const controller = new AbortController();
		controller.abort();

		const result = await mempalaceBackend.search!(context(fakeSession()), "baseline", { signal: controller.signal });

		expect(result.message).toBe("Search aborted.");
		expect(transport.calls).toHaveLength(0);
		expect(cliCalls).toHaveLength(0);
	});
});

describe("mempalaceBackend.save", () => {
	it("files a drawer into the project wing", async () => {
		transport.script("mempalace_add_drawer", JSON.stringify({ success: true, drawer_id: "abc123" }));

		const result = await mempalaceBackend.save!(context(fakeSession()), {
			content: "  the grid overlay must share the content box  ",
			context: "Design Decisions",
			source: "notes.md",
		});

		expect(result.stored).toBe(1);
		expect(result.ids).toEqual(["abc123"]);
		expect(transport.calls[0]).toEqual({
			name: "mempalace_add_drawer",
			args: {
				wing: "my_project",
				room: "design_decisions",
				content: "the grid overlay must share the content box",
				added_by: "omp",
				source_file: "notes.md",
			},
		});
	});

	it("routes explicit diary saves to the diary tool", async () => {
		transport.script("mempalace_diary_write", JSON.stringify({ success: true }));

		const result = await mempalaceBackend.save!(context(fakeSession()), {
			content: "SESSION:2026-07-25|wired.mempalace.backend",
			context: "diary",
		});

		expect(result.stored).toBe(1);
		expect(transport.calls[0].name).toBe("mempalace_diary_write");
		expect(transport.calls[0].args).toEqual({
			agent_name: "omp",
			entry: "SESSION:2026-07-25|wired.mempalace.backend",
			topic: "diary",
			wing: "my_project",
		});
	});

	it("reports a duplicate as stored without inventing an id", async () => {
		transport.script(
			"mempalace_add_drawer",
			JSON.stringify({ success: true, reason: "already_exists", drawer_id: "abc123" }),
		);

		const result = await mempalaceBackend.save!(context(fakeSession()), { content: "a fact" });

		expect(result.stored).toBe(1);
		expect(result.message).toContain("duplicate");
	});

	it("refuses empty content before any transport call", async () => {
		const result = await mempalaceBackend.save!(context(fakeSession()), { content: "   " });

		expect(result.stored).toBe(0);
		expect(result.message).toBe("Memory content is empty.");
		expect(transport.calls).toHaveLength(0);
	});

	it("never falls back to the CLI for writes", async () => {
		transport.failConnect = true;

		const result = await mempalaceBackend.save!(context(fakeSession()), { content: "a fact" });

		expect(result.stored).toBe(0);
		expect(result.message).toContain("MemPalace save failed");
		expect(cliCalls).toHaveLength(0);
	});
});

describe("mempalaceBackend.status", () => {
	it("is writable only while the MCP session is up", async () => {
		const session = fakeSession();

		const status = await mempalaceBackend.status!(context(session));

		expect(status.active).toBe(true);
		expect(status.writable).toBe(true);
		expect(status.searchable).toBe(true);
		expect(status.scope).toBe("my_project");
		expect(status.message).toContain("3.6.0");
		expect(status.message).toContain("MCP connected");
	});

	it("stays searchable but read-only when the MCP server will not start", async () => {
		transport.failConnect = true;

		const status = await mempalaceBackend.status!(context(fakeSession()));

		expect(status.active).toBe(true);
		expect(status.writable).toBe(false);
		expect(status.searchable).toBe(true);
		expect(status.message).toContain("MCP unavailable");
		expect(status.message).toContain("auto-ingest not attached");
	});

	it("reports the attached cadence after start", async () => {
		const session = fakeSession();
		await mempalaceBackend.start(startOptions(session));

		const status = await mempalaceBackend.status!(context(session));

		expect(status.message).toContain("auto-ingest attached");
	});
});

describe("mempalaceBackend.buildDeveloperInstructions", () => {
	it("appends the palace orientation text and caches the fetch", async () => {
		transport.script("mempalace_instructions", "PALACE: 3 wings, 118 drawers");
		const session = fakeSession();

		const first = await mempalaceBackend.buildDeveloperInstructions(AGENT_DIR, session.settings, session);
		const second = await mempalaceBackend.buildDeveloperInstructions(AGENT_DIR, session.settings, session);

		expect(first).toContain("MemPalace long-term memory");
		expect(first).toContain("PALACE: 3 wings, 118 drawers");
		expect(second).toBe(first!);
		expect(transport.calls.filter(call => call.name === "mempalace_instructions")).toHaveLength(1);
	});

	it("falls back to the CLI wake-up context", async () => {
		cliScript.set("wake-up", cliResult(0, "L0: my_project — 40 drawers"));
		const session = fakeSession();

		const rendered = await mempalaceBackend.buildDeveloperInstructions(AGENT_DIR, session.settings, session);

		expect(cliCalls[0]?.args).toEqual(["wake-up"]);
		expect(rendered).toContain("L0: my_project — 40 drawers");
	});

	it("still injects the static block when both transports are silent", async () => {
		const session = fakeSession();

		const rendered = await mempalaceBackend.buildDeveloperInstructions(AGENT_DIR, session.settings, session);

		expect(rendered).toContain("MemPalace long-term memory");
	});

	it("caps the injected section", async () => {
		transport.script("mempalace_instructions", "x".repeat(20_000));
		const session = fakeSession();

		const rendered = await mempalaceBackend.buildDeveloperInstructions(AGENT_DIR, session.settings, session);

		// ~900 tokens at 4 chars per token.
		expect(rendered!.length).toBeLessThanOrEqual(3600);
		expect(rendered!.endsWith("…")).toBe(true);
	});
});

describe("mempalaceBackend.stats and diagnose", () => {
	it("renders MCP status scalars as markdown bullets", async () => {
		transport.script(
			"mempalace_status",
			JSON.stringify({ total_drawers: 118, wings: ["a", "b"], palace_path: "/home/u/.mempalace" }),
		);

		const rendered = await mempalaceBackend.stats!(AGENT_DIR, PROJECT_DIR, fakeSession());

		expect(rendered).toContain("- **total_drawers**: 118");
		expect(rendered).toContain("- **wings**: 2 item(s)");
		expect(rendered).toContain("/home/u/.mempalace");
	});

	it("falls back to CLI status output", async () => {
		transport.failConnect = true;
		cliScript.set("status", cliResult(0, "118 drawers across 3 wings"));

		const rendered = await mempalaceBackend.stats!(AGENT_DIR, PROJECT_DIR, fakeSession());

		expect(cliCalls[0]?.args).toEqual(["status"]);
		expect(rendered).toContain("118 drawers across 3 wings");
	});

	it("diagnoses probe, transport, CLI, and ingest target", async () => {
		cliScript.set("status", cliResult(0, "118 drawers across 3 wings"));
		const session = fakeSession({ sessionFile: `${SESSION_DIR}/session.jsonl` });

		const rendered = await mempalaceBackend.diagnose!(AGENT_DIR, PROJECT_DIR, session);

		expect(rendered).toContain("- Python: python3");
		expect(rendered).toContain("- Version: 3.6.0");
		expect(rendered).toContain("- Connected: yes");
		expect(rendered).toContain("- Tools advertised: 2");
		expect(rendered).toContain("`mempalace status` exit code: 0");
		expect(rendered).toContain(`- Target: \`${SESSION_DIR}\` (source: session)`);
		expect(rendered).toContain("Counts toward preservation: yes");
	});

	it("names the missing interpreter in diagnostics", async () => {
		probe = MISSING_PROBE;
		await installDeps();

		const rendered = await mempalaceBackend.diagnose!(AGENT_DIR, PROJECT_DIR, fakeSession());

		expect(rendered).toContain("- Python: not found");
		expect(rendered).toContain("`mempalace` importable: no");
		expect(rendered).toContain("Transport: not created");
	});
});

describe("mempalaceBackend.preCompactionContext", () => {
	it("mines the session directory and reports preservation", async () => {
		cliScript.set("mine", cliResult(0, "mined 12 files"));
		const session = fakeSession({ sessionFile: `${SESSION_DIR}/session.jsonl` });

		const rendered = await mempalaceBackend.preCompactionContext!([], session.settings, session);

		expect(cliCalls[0]?.args).toEqual(["mine", SESSION_DIR, "--mode", "convos"]);
		expect(rendered).toContain(SESSION_DIR);
		expect(rendered).toContain("MemPalace");
	});

	it("stays silent when only the unsafe cwd fallback was mined", async () => {
		cliScript.set("mine", cliResult(0, "mined 12 files"));
		const session = fakeSession();

		const rendered = await mempalaceBackend.preCompactionContext!([], session.settings, session);

		expect(cliCalls[0]?.args).toEqual(["mine", PROJECT_DIR]);
		expect(rendered).toBeUndefined();
	});

	it("stays silent when the ingest fails", async () => {
		cliScript.set("mine", cliResult(1, "", "palace locked"));
		const session = fakeSession({ sessionFile: `${SESSION_DIR}/session.jsonl` });

		expect(await mempalaceBackend.preCompactionContext!([], session.settings, session)).toBeUndefined();
	});

	it("prefers MEMPALACE_DIR over the session directory", async () => {
		process.env.MEMPALACE_DIR = "/tmp/omp-mempalace/explicit";
		cliScript.set("mine", cliResult(0, "mined 12 files"));
		const session = fakeSession({ sessionFile: `${SESSION_DIR}/session.jsonl` });

		const rendered = await mempalaceBackend.preCompactionContext!([], session.settings, session);

		expect(cliCalls[0]?.args).toEqual(["mine", "/tmp/omp-mempalace/explicit"]);
		expect(rendered).toContain("/tmp/omp-mempalace/explicit");
	});
});

describe("mempalaceBackend.enqueue and clear", () => {
	it("mines the resolved target on demand", async () => {
		cliScript.set("mine", cliResult(0, "mined 12 files"));
		const session = fakeSession({ sessionFile: `${SESSION_DIR}/session.jsonl` });

		await mempalaceBackend.enqueue(AGENT_DIR, PROJECT_DIR, session);

		expect(cliCalls[0]?.args).toEqual(["mine", SESSION_DIR, "--mode", "convos"]);
	});

	it("survives an ingest failure", async () => {
		cliScript.set("mine", cliResult(1, "", "palace locked"));

		await mempalaceBackend.enqueue(AGENT_DIR, PROJECT_DIR, fakeSession());

		expect(cliCalls[0]?.args[0]).toBe("mine");
	});

	it("leaves the shared palace store alone on clear", async () => {
		await mempalaceBackend.clear(AGENT_DIR, PROJECT_DIR, fakeSession());

		expect(cliCalls).toHaveLength(0);
		expect(transport.calls).toHaveLength(0);
	});
});

describe("deriveWing", () => {
	it("sanitizes a project directory into a writable wing name", () => {
		expect(deriveWing("/tmp/omp-mempalace/My Project")).toBe("my_project");
		expect(deriveWing("/tmp/oh-my-pi")).toBe("oh_my_pi");
	});

	it("strips leading underscores that mempalace rejects", () => {
		expect(deriveWing("/tmp/.config")).toBe("config");
	});

	it("falls back when nothing survives sanitization", () => {
		expect(deriveWing("/")).toBe("workspace");
	});
});
