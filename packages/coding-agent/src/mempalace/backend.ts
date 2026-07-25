/**
 * MemPalace memory backend.
 *
 * Delegates to the local Python `mempalace` package over two transports: the
 * MCP stdio server (rich, structured, preferred) and the CLI (coarse, but
 * available whenever the package is importable). Reads fall back MCP → CLI;
 * writes are MCP-only because the CLI has no drawer-write subcommand.
 *
 * The hard requirement is totality: a machine with no Python, no `mempalace`,
 * or a wedged server must see informative status text instead of an exception.
 * Every method here therefore swallows its own failures — the backend degrades,
 * the agent loop does not.
 *
 * Dependencies are reachable through `setMempalaceDepsForTests` so the contract
 * can be pinned without Python.
 */

import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type {
	MemoryBackend,
	MemoryBackendSearchItem,
	MemoryBackendSearchResult,
	MemoryBackendStatus,
} from "../memory-backend/types";
import type { AgentSession } from "../session/agent-session";
import { CircuitBreaker, type CliRunResult, runMempalaceCli } from "./cli";
import { probeMempalace } from "./env";
import { isPreservationSatisfied, resolveIngestTarget } from "./policies";
import { MempalaceSessionState } from "./state";
import { MempalaceTransport, type MempalaceTransportOptions } from "./transport";
import type { IngestTarget, MempalaceCallResult, MempalaceProbe } from "./types";

const BACKEND_ID = "mempalace" as const;
const INSTALL_HINT = "MemPalace backend selected but Python/mempalace is not installed — run `pip install mempalace`.";
/** `added_by` / `agent_name` stamped on everything this backend files. */
const AGENT_NAME = "omp";
/** Room used when the caller gives no context to file under. */
const DEFAULT_ROOM = "notes";
/** Wing used when the project directory sanitizes down to nothing. */
const FALLBACK_WING = "workspace";
/** Injection budget for the system-prompt section. */
const MAX_INSTRUCTION_TOKENS = 900;
/** Wall clock for the instructions fetch — it blocks the first prompt build. */
const INSTRUCTIONS_TIMEOUT_MS = 10_000;
/** Exit code reported when the breaker refuses to run the CLI at all. */
const EXIT_BREAKER_OPEN = 125;
/** Exit code reported when the CLI runner itself blew up. */
const EXIT_RUNNER_FAILED = 127;

const STATIC_INSTRUCTIONS = [
	"## MemPalace long-term memory",
	"",
	"Durable memory for this machine lives in a local MemPalace store (wings → rooms → verbatim drawers).",
	"Recall it with the memory search command before assuming something is unknown, and file decisions,",
	"quotes, and hard-won facts with the memory save command — verbatim, never summarized.",
].join("\n");

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

/** The slice of `MempalaceTransport` this backend actually uses. */
export interface MempalaceTransportLike {
	readonly connected: boolean;
	connect(): Promise<void>;
	callTool(
		name: string,
		args: Record<string, unknown>,
		opts?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<MempalaceCallResult>;
	listToolNames(): Promise<string[]>;
	close(): Promise<void>;
}

/** The slice of `MempalaceSessionState` this backend actually uses. */
export interface MempalaceSessionStateLike {
	attach(): void;
	detach(): void;
	maybeImportLocalMemories(): Promise<void>;
}

export interface MempalaceSessionStateFactoryOptions {
	session: AgentSession;
	settings: Settings;
	agentDir: string;
	runIngest: (target: IngestTarget) => Promise<CliRunResult>;
}

export interface MempalaceBackendDeps {
	probe(): Promise<MempalaceProbe>;
	createTransport(options: MempalaceTransportOptions): MempalaceTransportLike;
	runCli(args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<CliRunResult>;
	createSessionState(options: MempalaceSessionStateFactoryOptions): MempalaceSessionStateLike;
}

const defaultDeps: MempalaceBackendDeps = {
	probe: probeMempalace,
	createTransport: options => new MempalaceTransport(options),
	runCli: runMempalaceCli,
	createSessionState: options => new MempalaceSessionState(options),
};

let deps: MempalaceBackendDeps = defaultDeps;

// ---------------------------------------------------------------------------
// Process-wide runtime (one palace, one MCP subprocess, one breaker)
// ---------------------------------------------------------------------------

interface MempalaceRuntime {
	probe: MempalaceProbe;
	/** Undefined when the probe found nothing to talk to. */
	transport: MempalaceTransportLike | undefined;
}

let runtimePromise: Promise<MempalaceRuntime> | undefined;
let cliBreaker = new CircuitBreaker();
let instructionsCache: string | undefined;
let instructionsFetched = false;
let lastIngest: { target: IngestTarget; exitCode: number } | undefined;

/**
 * Swap in fakes and reset all process-wide state. Passing nothing restores the
 * real dependencies.
 */
export async function setMempalaceDepsForTests(overrides?: Partial<MempalaceBackendDeps>): Promise<void> {
	await resetMempalaceRuntimeForTests();
	deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

/** Drop the cached probe/transport/breaker so the next call re-resolves. */
export async function resetMempalaceRuntimeForTests(): Promise<void> {
	const pending = runtimePromise;
	runtimePromise = undefined;
	cliBreaker = new CircuitBreaker();
	instructionsCache = undefined;
	instructionsFetched = false;
	lastIngest = undefined;
	if (!pending) return;
	const runtime = await pending.catch(() => undefined);
	await runtime?.transport?.close().catch(() => {});
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function timeoutSetting(
	settings: Settings | undefined,
	key: "mempalace.connectTimeoutMs" | "mempalace.requestTimeoutMs",
): number | undefined {
	try {
		const value = settings?.get(key);
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
		return value;
	} catch {
		// A settings store that cannot answer is not a reason to fail a memory call.
		return undefined;
	}
}

async function createRuntime(settings: Settings | undefined): Promise<MempalaceRuntime> {
	let probe: MempalaceProbe;
	try {
		probe = await deps.probe();
	} catch (error) {
		probe = { pythonCommand: undefined, installed: false, detail: `MemPalace probe failed: ${describeError(error)}` };
	}
	if (!probe.installed || !probe.pythonCommand) return { probe, transport: undefined };

	const connectTimeoutMs = timeoutSetting(settings, "mempalace.connectTimeoutMs");
	const requestTimeoutMs = timeoutSetting(settings, "mempalace.requestTimeoutMs");
	try {
		const transport = deps.createTransport({
			pythonCommand: probe.pythonCommand,
			...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
			...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
		});
		return { probe, transport };
	} catch (error) {
		logger.warn("MemPalace: MCP transport could not be created; CLI only.", { error: describeError(error) });
		return { probe, transport: undefined };
	}
}

/** Resolve (and memoize) the probe + transport pair. Never rejects. */
function ensureRuntime(settings: Settings | undefined): Promise<MempalaceRuntime> {
	runtimePromise ??= createRuntime(settings);
	return runtimePromise;
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

function unavailable(probe: MempalaceProbe): string {
	if (!probe.installed) return probe.detail ? `${INSTALL_HINT} (${probe.detail})` : INSTALL_HINT;
	return "MemPalace MCP server is unavailable.";
}

/** Call an MCP tool. Never throws; an unreachable server is an `ok: false`. */
async function callTool(
	name: string,
	args: Record<string, unknown>,
	settings: Settings | undefined,
	opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<MempalaceCallResult> {
	try {
		const runtime = await ensureRuntime(settings);
		if (!runtime.transport) return { ok: false, text: "", error: unavailable(runtime.probe), via: "mcp" };
		return await runtime.transport.callTool(name, args, opts);
	} catch (error) {
		return { ok: false, text: "", error: `MemPalace MCP call "${name}" failed: ${describeError(error)}`, via: "mcp" };
	}
}

/**
 * Run the CLI behind the breaker. A tripped breaker short-circuits with exit
 * 125 so repeated failures cost nothing; a clean exit closes it again.
 */
async function runCliGuarded(args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<CliRunResult> {
	const command = ["mempalace", ...args];
	if (cliBreaker.open) {
		return {
			exitCode: EXIT_BREAKER_OPEN,
			stdout: "",
			stderr: "MemPalace CLI is temporarily disabled after repeated failures.",
			command,
		};
	}
	let result: CliRunResult;
	try {
		result = await deps.runCli(args, opts);
	} catch (error) {
		cliBreaker.recordFailure();
		return { exitCode: EXIT_RUNNER_FAILED, stdout: "", stderr: describeError(error), command };
	}
	if (result.exitCode === 0) cliBreaker.recordSuccess();
	else cliBreaker.recordFailure();
	return result;
}

// ---------------------------------------------------------------------------
// Naming + payload helpers
// ---------------------------------------------------------------------------

/**
 * Wing name for a project directory.
 *
 * mempalace rejects wings that start with `_`, so the leading underscores a
 * sanitized dotfile-style basename would produce are stripped.
 */
export function deriveWing(dir: string): string {
	return sanitizeName(path.basename(path.resolve(dir))) ?? FALLBACK_WING;
}

/** Same character class as a wing, for room/topic names. `undefined` when empty. */
function sanitizeName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+/, "")
		.replace(/_+$/, "");
	return sanitized || undefined;
}

function firstLine(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	const index = trimmed.indexOf("\n");
	return index === -1 ? trimmed : trimmed.slice(0, index);
}

/** ~4 chars per token, mirroring the mnemopi injection cap. */
function truncateApproxTokens(text: string, tokenLimit: number): string {
	const maxChars = Math.max(0, tokenLimit * 4);
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function optionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed === "unknown" || trimmed === "?") return undefined;
	return trimmed;
}

function clampLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit)) return 5;
	return Math.max(1, Math.min(100, Math.trunc(limit ?? 5)));
}

function toSearchItem(hit: Record<string, unknown>): MemoryBackendSearchItem {
	const wing = optionalString(hit.wing);
	const room = optionalString(hit.room);
	const location = wing && room ? `${wing}/${room}` : wing;
	const item: MemoryBackendSearchItem = {
		content: typeof hit.text === "string" ? hit.text : String(hit.text ?? ""),
	};
	const id = optionalString(hit.drawer_id) ?? optionalString(hit.id);
	if (id) item.id = id;
	const source = optionalString(hit.source_path) ?? optionalString(hit.source_file) ?? location;
	if (source) item.source = source;
	const timestamp = optionalString(hit.authored_at) ?? optionalString(hit.created_at);
	if (timestamp) item.timestamp = timestamp;
	if (typeof hit.similarity === "number") item.score = hit.similarity;
	return item;
}

/**
 * Parse a `mempalace_search` payload into backend items.
 *
 * Returns `undefined` when the text is not a recognisable search payload, which
 * the caller distinguishes from a payload that legitimately found nothing.
 */
function parseSearchPayload(text: string, limit: number): MemoryBackendSearchItem[] | undefined {
	const payload = parseJsonObject(text);
	if (!payload || !Array.isArray(payload.results)) return undefined;
	const items: MemoryBackendSearchItem[] = [];
	for (const hit of payload.results) {
		if (typeof hit !== "object" || hit === null) continue;
		items.push(toSearchItem(hit as Record<string, unknown>));
		if (items.length >= limit) break;
	}
	return items;
}

function emptySearch(query: string, message: string): MemoryBackendSearchResult {
	return { backend: BACKEND_ID, query, count: 0, items: [], message };
}

// ---------------------------------------------------------------------------
// Session state registry
// ---------------------------------------------------------------------------

const kMempalaceSessionState = Symbol.for("omp.mempalace.sessionState");
type SessionWithState = AgentSession & { [kMempalaceSessionState]?: MempalaceSessionStateLike };

function getSessionState(session: AgentSession | undefined): MempalaceSessionStateLike | undefined {
	return session ? (session as SessionWithState)[kMempalaceSessionState] : undefined;
}

function setSessionState(
	session: AgentSession,
	state: MempalaceSessionStateLike | undefined,
): MempalaceSessionStateLike | undefined {
	const typed = session as SessionWithState;
	const previous = typed[kMempalaceSessionState];
	if (state) typed[kMempalaceSessionState] = state;
	else delete typed[kMempalaceSessionState];
	return previous;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

function sessionCwd(session: AgentSession | undefined): string | undefined {
	try {
		return session?.sessionManager.getCwd();
	} catch {
		return undefined;
	}
}

function sessionFileDir(session: AgentSession | undefined): string | undefined {
	try {
		const file = session?.sessionFile;
		return file ? path.dirname(file) : undefined;
	} catch {
		return undefined;
	}
}

function ingestTargetFor(session: AgentSession | undefined, cwd: string): IngestTarget {
	const dir = sessionFileDir(session);
	return resolveIngestTarget({ cwd, ...(dir ? { sessionFileDir: dir } : {}) });
}

/** Mine a directory into the palace. Never throws; the breaker guards repeats. */
async function runIngest(target: IngestTarget): Promise<CliRunResult> {
	const result = await runCliGuarded(["mine", target.dir]);
	lastIngest = { target, exitCode: result.exitCode };
	if (result.exitCode !== 0) {
		logger.debug("MemPalace: ingest failed.", {
			dir: target.dir,
			source: target.source,
			exitCode: result.exitCode,
			stderr: firstLine(result.stderr),
		});
	}
	return result;
}

// ---------------------------------------------------------------------------
// Developer instructions
// ---------------------------------------------------------------------------

/**
 * Fetch the palace's own orientation text once per process: MCP first, then the
 * CLI wake-up context, then nothing. Failures are cached too — the first prompt
 * build must not turn into a per-turn retry loop.
 */
async function loadPalaceInstructions(
	settings: Settings | undefined,
	cwd: string | undefined,
): Promise<string | undefined> {
	if (instructionsFetched) return instructionsCache;
	instructionsFetched = true;

	const mcp = await callTool("mempalace_instructions", { name: "help" }, settings, {
		timeoutMs: INSTRUCTIONS_TIMEOUT_MS,
	});
	if (mcp.ok && mcp.text.trim()) {
		instructionsCache = mcp.text.trim();
		return instructionsCache;
	}

	const cli = await runCliGuarded(["wake-up"], {
		timeoutMs: INSTRUCTIONS_TIMEOUT_MS,
		...(cwd ? { cwd } : {}),
	});
	instructionsCache = cli.exitCode === 0 && cli.stdout.trim() ? cli.stdout.trim() : undefined;
	return instructionsCache;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderScalar(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `${value.length} item(s)`;
	if (typeof value === "object" && value !== null) return `${Object.keys(value).length} key(s)`;
	return undefined;
}

function renderStats(text: string): string {
	const payload = parseJsonObject(text);
	if (!payload) return ["# MemPalace Stats", "", "```", text.trim(), "```"].join("\n");
	const lines = ["# MemPalace Stats", ""];
	for (const [key, value] of Object.entries(payload)) {
		const rendered = renderScalar(value);
		if (rendered !== undefined) lines.push(`- **${key}**: ${rendered}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export const mempalaceBackend: MemoryBackend = {
	id: BACKEND_ID,

	async start(options): Promise<void> {
		try {
			const { session, settings, agentDir } = options;
			const runtime = await ensureRuntime(settings);
			if (!runtime.probe.installed) {
				logger.warn("MemPalace: backend selected but the Python package is unavailable; memory backend inert.", {
					detail: runtime.probe.detail ?? INSTALL_HINT,
				});
				return;
			}

			// Warm the MCP subprocess without blocking startup; connect() never rejects.
			void runtime.transport?.connect();

			// Subagents share the parent's palace — a second cadence would mine the
			// same directory twice per interval.
			if (options.taskDepth > 0) return;

			const state = deps.createSessionState({
				session,
				settings,
				agentDir,
				runIngest,
			});
			state.attach();
			setSessionState(session, state)?.detach();
			void state.maybeImportLocalMemories().catch((error: unknown) => {
				logger.warn("MemPalace: local memory import failed.", { error: describeError(error) });
			});
		} catch (error) {
			logger.warn("MemPalace: backend startup failed; memory backend inert.", { error: describeError(error) });
		}
	},

	async buildDeveloperInstructions(_agentDir, settings, session): Promise<string | undefined> {
		try {
			const runtime = await ensureRuntime(settings);
			if (!runtime.probe.installed) return undefined;
			const dynamic = await loadPalaceInstructions(settings, sessionCwd(session));
			const rendered = [STATIC_INSTRUCTIONS, dynamic].filter(Boolean).join("\n\n").trim();
			if (!rendered) return undefined;
			return truncateApproxTokens(rendered, MAX_INSTRUCTION_TOKENS);
		} catch (error) {
			logger.debug("MemPalace: instruction build failed.", { error: describeError(error) });
			return undefined;
		}
	},

	/**
	 * Deliberately inert. The palace is a user-level store shared across every
	 * project and agent on the machine; wiping it from a coding session would
	 * destroy memory this backend never created. Pruning is `mempalace`'s own job.
	 */
	async clear(): Promise<void> {
		logger.info("MemPalace: clear is a no-op — the palace store is managed by the mempalace CLI.");
	},

	async enqueue(_agentDir, cwd, session): Promise<void> {
		try {
			const runtime = await ensureRuntime(session?.settings);
			if (!runtime.probe.installed) {
				logger.warn("MemPalace: enqueue skipped.", { detail: unavailable(runtime.probe) });
				return;
			}
			const target = ingestTargetFor(session, cwd);
			const result = await runIngest(target);
			if (result.exitCode === 0) {
				logger.info("MemPalace: ingest complete.", { dir: target.dir, source: target.source });
			} else {
				logger.warn("MemPalace: ingest failed.", {
					dir: target.dir,
					exitCode: result.exitCode,
					stderr: firstLine(result.stderr),
				});
			}
		} catch (error) {
			logger.warn("MemPalace: enqueue failed.", { error: describeError(error) });
		}
	},

	async status({ cwd, session }): Promise<MemoryBackendStatus> {
		const runtime = await ensureRuntime(session?.settings);
		if (!runtime.probe.installed) {
			return {
				backend: BACKEND_ID,
				active: false,
				writable: false,
				searchable: false,
				message: INSTALL_HINT,
				...(runtime.probe.detail ? { error: runtime.probe.detail } : {}),
			};
		}

		// A user asking for status wants the connection actually tried, not the
		// stale flag from before the first call. connect() is idempotent and total.
		await runtime.transport?.connect().catch(() => {});
		const connected = runtime.transport?.connected === true;
		const version = runtime.probe.version ?? "(unknown version)";
		const transportNote = connected
			? "MCP connected"
			: "MCP unavailable — reads fall back to the CLI, writes are disabled";
		const cadence = getSessionState(session) ? "auto-ingest attached" : "auto-ingest not attached";

		return {
			backend: BACKEND_ID,
			active: true,
			writable: connected,
			searchable: true,
			scope: deriveWing(cwd),
			message: `MemPalace ${version} via \`${runtime.probe.pythonCommand}\` — ${transportNote}; ${cadence}.`,
		};
	},

	async search({ cwd, session }, query, options): Promise<MemoryBackendSearchResult> {
		if (options?.signal?.aborted) return emptySearch(query, "Search aborted.");
		const settings = session?.settings;
		const limit = clampLimit(options?.limit);

		const mcp = await callTool(
			"mempalace_search",
			{ query, limit },
			settings,
			options?.signal ? { signal: options.signal } : undefined,
		);
		if (mcp.ok) {
			const items = parseSearchPayload(mcp.text, limit);
			if (items) return { backend: BACKEND_ID, query, count: items.length, items };
			const raw = mcp.text.trim();
			if (!raw) return emptySearch(query, "MemPalace returned an empty search payload.");
			return {
				backend: BACKEND_ID,
				query,
				count: 1,
				items: [{ content: raw, source: "mempalace-mcp" }],
				message: "MemPalace returned an unrecognised search payload; showing it verbatim.",
			};
		}

		if (options?.signal?.aborted) return emptySearch(query, "Search aborted.");
		const cli = await runCliGuarded(["search", query, "--results", String(limit)], { cwd });
		if (cli.exitCode !== 0) {
			return emptySearch(
				query,
				`MemPalace search failed — MCP: ${mcp.error ?? "unavailable"}; CLI exit ${cli.exitCode}: ${
					firstLine(cli.stderr) || "no output"
				}`,
			);
		}
		const degraded = `MCP unavailable (${mcp.error ?? "unknown error"}); results came from the mempalace CLI.`;
		const parsed = parseSearchPayload(cli.stdout, limit);
		if (parsed) return { backend: BACKEND_ID, query, count: parsed.length, items: parsed, message: degraded };
		const raw = cli.stdout.trim();
		if (!raw) return emptySearch(query, `${degraded} No results.`);
		return {
			backend: BACKEND_ID,
			query,
			count: 1,
			items: [{ content: raw, source: "mempalace-cli" }],
			message: degraded,
		};
	},

	async save({ cwd, session }, input) {
		const content = input.content.trim();
		if (!content) return { backend: BACKEND_ID, stored: 0, message: "Memory content is empty." };

		const wing = deriveWing(cwd);
		const label = sanitizeName(input.context);
		// Diary entries are session narrative; drawers are verbatim facts. The
		// caller opts into the diary explicitly — nothing here guesses.
		const diary = label === "diary" || sanitizeName(input.source) === "diary";
		const [tool, args]: [string, Record<string, unknown>] = diary
			? ["mempalace_diary_write", { agent_name: AGENT_NAME, entry: content, topic: label ?? "general", wing }]
			: [
					"mempalace_add_drawer",
					{
						wing,
						room: label ?? DEFAULT_ROOM,
						content,
						added_by: AGENT_NAME,
						...(input.source ? { source_file: input.source } : {}),
					},
				];

		const result = await callTool(tool, args, session?.settings);
		if (!result.ok) {
			const error = result.error ?? "unknown error";
			return { backend: BACKEND_ID, stored: 0, message: `MemPalace save failed: ${error}` };
		}
		const payload = parseJsonObject(result.text);
		const id = optionalString(payload?.drawer_id) ?? optionalString(payload?.id);
		const reason = optionalString(payload?.reason);
		return {
			backend: BACKEND_ID,
			stored: 1,
			...(id ? { ids: [id] } : {}),
			message: reason === "already_exists" ? `Already filed in ${wing} (duplicate).` : `Filed into ${wing}.`,
		};
	},

	async stats(_agentDir, cwd, session): Promise<string | undefined> {
		const mcp = await callTool("mempalace_status", {}, session?.settings);
		if (mcp.ok && mcp.text.trim()) return renderStats(mcp.text);

		const cli = await runCliGuarded(["status"], { cwd });
		if (cli.exitCode === 0 && cli.stdout.trim()) {
			return ["# MemPalace Stats", "", "```", cli.stdout.trim(), "```"].join("\n");
		}
		const detail = firstLine(cli.stderr) || "no output";
		return [
			"# MemPalace Stats",
			"",
			`Unavailable — MCP: ${mcp.error ?? "no payload"}; CLI exit ${cli.exitCode}: ${detail}`,
		].join("\n");
	},

	async diagnose(_agentDir, cwd, session): Promise<string | undefined> {
		const runtime = await ensureRuntime(session?.settings);
		const probe = runtime.probe;
		const lines = [
			"# MemPalace Diagnostics",
			"",
			"## Environment",
			`- Python: ${probe.pythonCommand ?? "not found"}`,
			`- \`mempalace\` importable: ${probe.installed ? "yes" : "no"}`,
			`- Version: ${probe.version ?? "unknown"}`,
		];
		if (probe.detail) lines.push(`- Detail: ${probe.detail}`);

		lines.push("", "## MCP");
		if (!runtime.transport) {
			lines.push("- Transport: not created (no usable Python interpreter)");
		} else {
			await runtime.transport.connect().catch(() => {});
			const tools = runtime.transport.connected ? await runtime.transport.listToolNames().catch(() => []) : [];
			lines.push(`- Connected: ${runtime.transport.connected ? "yes" : "no"}`);
			lines.push(`- Tools advertised: ${tools.length}`);
			if (!runtime.transport.connected) lines.push("- Writes are disabled until the MCP server connects.");
		}

		lines.push("", "## CLI");
		if (cliBreaker.open) {
			lines.push("- Breaker: open (skipping CLI calls until cooldown elapses)");
		} else {
			const cli = await runCliGuarded(["status"], { cwd });
			lines.push(`- \`mempalace status\` exit code: ${cli.exitCode}`);
			const detail = firstLine(cli.exitCode === 0 ? cli.stdout : cli.stderr);
			if (detail) lines.push(`- Output: ${detail}`);
		}

		const target = ingestTargetFor(session, cwd);
		lines.push(
			"",
			"## Ingest",
			`- Target: \`${target.dir}\` (source: ${target.source})`,
			`- Counts toward preservation: ${target.source === "cwd" ? "no — cwd is the unsafe fallback" : "yes"}`,
			lastIngest
				? `- Last run: \`${lastIngest.target.dir}\` exit ${lastIngest.exitCode}`
				: "- Last run: none this process",
			`- Session cadence: ${getSessionState(session) ? "attached" : "not attached"}`,
		);
		return lines.join("\n");
	},

	async preCompactionContext(_messages, settings, session): Promise<string | undefined> {
		try {
			const runtime = await ensureRuntime(settings);
			if (!runtime.probe.installed) return undefined;
			const cwd = sessionCwd(session) ?? process.cwd();
			const target = ingestTargetFor(session, cwd);
			const result = await runIngest(target);
			if (!isPreservationSatisfied({ exitCode: result.exitCode, target })) {
				logger.warn("MemPalace: pre-compaction ingest did not preserve this session.", {
					dir: target.dir,
					source: target.source,
					exitCode: result.exitCode,
				});
				return undefined;
			}
			return [
				"## MemPalace",
				"",
				`This session was mined into the MemPalace store from \`${target.dir}\` before compaction, so its`,
				"details remain recallable. Prefer a memory search over re-summarising them here.",
			].join("\n");
		} catch (error) {
			logger.debug("MemPalace: pre-compaction ingest failed.", { error: describeError(error) });
			return undefined;
		}
	},
};
