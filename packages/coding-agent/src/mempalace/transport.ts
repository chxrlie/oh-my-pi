/**
 * MCP stdio adapter for the local Python `mempalace` package.
 *
 * Thin wrapper over the core MCP client (`src/mcp/`) — no hand-rolled
 * JSON-RPC. The only value added here is mempalace-specific policy:
 *
 * - lazy, idempotent connect that never throws (a missing Python or a server
 *   that dies during startup degrades to "not connected", never a rejection
 *   escaping a backend entrypoint);
 * - per-call timeouts layered on the request `AbortSignal`;
 * - mempalace's domain-error convention: tools answer with a JSON string in
 *   the first text content block, and signal failure with `"success": false`
 *   plus an `error` field rather than an MCP-level `isError`.
 */
import {
	connectToServer,
	disconnectServer,
	listTools,
	type MCPContent,
	type MCPServerConnection,
	type MCPStdioServerConfig,
	type MCPToolCallResult,
	callTool as mcpCallTool,
} from "../mcp";
import type { MempalaceCallResult } from "./types";

/** Fallback timeout for both connect and per-request deadlines. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Default stdio server argv (appended to the Python launcher). */
const DEFAULT_SERVER_ARGS = ["-m", "mempalace.mcp_server"];
/** Connection name reported in core MCP error messages. */
const SERVER_NAME = "mempalace";

const CONNECT_TIMEOUT_ENV = "MEMPALACE_MCP_CONNECT_TIMEOUT_MS";
const REQUEST_TIMEOUT_ENV = "MEMPALACE_MCP_REQUEST_TIMEOUT_MS";

export interface MempalaceTransportOptions {
	/** Python launcher from the environment probe (`python3` / `python`). */
	pythonCommand: string;
	/** Connect deadline; defaults to `MEMPALACE_MCP_CONNECT_TIMEOUT_MS`, else 30s. */
	connectTimeoutMs?: number;
	/** Per-call deadline; defaults to `MEMPALACE_MCP_REQUEST_TIMEOUT_MS`, else 30s. */
	requestTimeoutMs?: number;
	/** Extra environment for the server subprocess. */
	env?: Record<string, string>;
	/** Server argv; defaults to `["-m", "mempalace.mcp_server"]`. */
	serverArgs?: string[];
	/** Full command override (defaults to `pythonCommand`) — used by tests. */
	command?: string;
}

/** Resolve a timeout: explicit option wins, then env var, then the default. */
function resolveTimeoutMs(explicit: number | undefined, envKey: string): number {
	if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit;
	const raw = Bun.env[envKey]?.trim();
	if (raw) {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return DEFAULT_TIMEOUT_MS;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** First text content block of a tool result, or `""` when there is none. */
function firstText(content: MCPContent[] | undefined): string {
	if (!content) return "";
	for (const block of content) {
		if (block.type === "text") return block.text;
	}
	return "";
}

/**
 * mempalace domain-error convention: the text payload is a JSON object with
 * `"success": false` and an `error` string. Returns the error message when the
 * payload says the call failed, otherwise `undefined` (including for payloads
 * that are not JSON objects at all — plain text is treated as success).
 */
function domainError(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return undefined;
	let payload: unknown;
	try {
		payload = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (typeof payload !== "object" || payload === null) return undefined;
	const record = payload as { success?: unknown; error?: unknown };
	if (record.success !== false) return undefined;
	const message = typeof record.error === "string" ? record.error.trim() : "";
	return message.length > 0 ? message : "MemPalace tool call failed";
}

function toCallResult(name: string, result: MCPToolCallResult): MempalaceCallResult {
	const text = firstText(result.content);
	if (result.isError === true) {
		const message = domainError(text) ?? (text.trim() || `MemPalace tool "${name}" reported an error`);
		return { ok: false, text, error: message, via: "mcp" };
	}
	const failure = domainError(text);
	if (failure !== undefined) return { ok: false, text, error: failure, via: "mcp" };
	return { ok: true, text, via: "mcp" };
}

function failure(error: string): MempalaceCallResult {
	return { ok: false, text: "", error, via: "mcp" };
}

/**
 * Lazily-connected MCP stdio client for the mempalace server.
 *
 * Every public method is total: connection problems surface as `ok: false`
 * results (or an empty tool list), never as thrown errors.
 */
export class MempalaceTransport {
	readonly #config: MCPStdioServerConfig;
	readonly #requestTimeoutMs: number;
	#connection: MCPServerConnection | undefined;
	#connecting: Promise<void> | undefined;
	#lastError: string | undefined;

	constructor(opts: MempalaceTransportOptions) {
		this.#config = {
			type: "stdio",
			command: opts.command ?? opts.pythonCommand,
			args: [...(opts.serverArgs ?? DEFAULT_SERVER_ARGS)],
			timeout: resolveTimeoutMs(opts.connectTimeoutMs, CONNECT_TIMEOUT_ENV),
			...(opts.env ? { env: { ...opts.env } } : {}),
		};
		this.#requestTimeoutMs = resolveTimeoutMs(opts.requestTimeoutMs, REQUEST_TIMEOUT_ENV);
	}

	/** True once an MCP session has been established and not yet closed. */
	get connected(): boolean {
		return this.#connection !== undefined;
	}

	/**
	 * Establish the MCP session. Idempotent and concurrency-safe: parallel
	 * callers share one attempt. Never throws — a failed attempt is recorded
	 * and reported by `callTool`, and the next `connect()` retries.
	 */
	async connect(): Promise<void> {
		if (this.#connection) return;
		this.#connecting ??= this.#open();
		await this.#connecting;
	}

	async #open(): Promise<void> {
		try {
			this.#connection = await connectToServer(SERVER_NAME, this.#config);
			this.#lastError = undefined;
		} catch (error) {
			this.#connection = undefined;
			this.#lastError = `MemPalace MCP server failed to start (${this.#config.command}): ${describeError(error)}`;
		} finally {
			this.#connecting = undefined;
		}
	}

	/** Call a mempalace MCP tool. Never throws. */
	async callTool(
		name: string,
		args: Record<string, unknown>,
		opts?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<MempalaceCallResult> {
		try {
			await this.connect();
			const connection = this.#connection;
			if (!connection) {
				return failure(this.#lastError ?? `MemPalace MCP server "${this.#config.command}" is not connected`);
			}

			const timeoutMs = opts?.timeoutMs ?? this.#requestTimeoutMs;
			const controller = new AbortController();
			let timedOut = false;
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							timedOut = true;
							controller.abort(new Error(`MemPalace MCP call "${name}" timed out after ${timeoutMs}ms`));
						}, timeoutMs)
					: undefined;
			const signal = opts?.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;

			try {
				const result = await mcpCallTool(connection, name, args, { signal });
				return toCallResult(name, result);
			} catch (error) {
				if (timedOut) {
					return failure(`MemPalace MCP call "${name}" timed out after ${timeoutMs}ms`);
				}
				return failure(`MemPalace MCP call "${name}" failed: ${describeError(error)}`);
			} finally {
				clearTimeout(timer);
			}
		} catch (error) {
			return failure(`MemPalace MCP call "${name}" failed: ${describeError(error)}`);
		}
	}

	/** Tool names advertised by the server; `[]` when unreachable. Never throws. */
	async listToolNames(): Promise<string[]> {
		try {
			await this.connect();
			const connection = this.#connection;
			if (!connection) return [];
			const tools = await listTools(connection);
			return tools.map(tool => tool.name);
		} catch {
			return [];
		}
	}

	/** Tear down the subprocess. Idempotent and non-throwing. */
	async close(): Promise<void> {
		// Let an in-flight connect settle first so its subprocess is not leaked.
		const pending = this.#connecting;
		if (pending) await pending.catch(() => {});
		const connection = this.#connection;
		this.#connection = undefined;
		this.#connecting = undefined;
		if (!connection) return;
		try {
			await disconnectServer(connection);
		} catch {
			// Already dead — nothing to reclaim.
		}
	}
}
