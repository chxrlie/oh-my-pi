/**
 * Shared types for the MemPalace memory backend subsystem.
 *
 * The backend delegates to the local Python `mempalace` package via two
 * transports: the MCP stdio server (`python -m mempalace.mcp_server`) and the
 * CLI (`python -m mempalace …`). Everything here is transport-agnostic glue.
 */

/** Result of probing the local Python environment for the mempalace package. */
export interface MempalaceProbe {
	/** Working Python launcher (`python3` or `python`), or undefined when no Python is available. */
	pythonCommand: string | undefined;
	/** Whether the `mempalace` package is importable in that Python. */
	installed: boolean;
	/** Reported `mempalace.__version__` when installed. */
	version?: string;
	/** Human-readable description of the missing prerequisite when degraded. */
	detail?: string;
}

/** Uniform result of a mempalace call over MCP or CLI. */
export interface MempalaceCallResult {
	ok: boolean;
	/** Raw textual payload (MCP tool text content or CLI stdout). */
	text: string;
	error?: string;
	via: "mcp" | "cli";
}

/** Resolved auto-ingest target directory and where it came from. */
export interface IngestTarget {
	dir: string;
	source: "env" | "session" | "cwd";
}
