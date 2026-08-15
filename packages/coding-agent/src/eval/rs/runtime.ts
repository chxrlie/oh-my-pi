/**
 * Rust runtime resolution utilities.
 *
 * Single-shot model: finds `rustc` on PATH for compiling eval cells.
 * No persistent kernel — each cell is a standalone compilation.
 */
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import { createEnvFilter, enumerateRuntimes, resolveRuntime, resolveExplicitPath } from "../runtime-env";

// Rust doesn't need version-manager env vars the way Ruby/Python/Julia do.
// Keep a minimal allowlist so secrets don't leak into child processes.
const DEFAULT_ENV_ALLOWLIST = [
	"CARGO_HOME",
	"RUSTUP_HOME",
	"RUSTC_WRAPPER",
	"RUSTFLAGS",
	"RUSTDOCFLAGS",
	"TMPDIR",
	"TMP",
	"TEMP",
	"HOME",
	"USER",
	"USERPROFILE",
	"LANG",
	"LC_ALL",
	"PATH",
	"TERM",
];

const DEFAULT_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "PI_"];

export const filterEnv = createEnvFilter({
	allowList: DEFAULT_ENV_ALLOWLIST,
	windowsAllowList: [],
	allowPrefixes: DEFAULT_ENV_ALLOW_PREFIXES,
	denyList: [],
});

export interface RustRuntime {
	/** Absolute path to the `rustc` binary. */
	rustcPath: string;
	/** Filtered environment for child processes. */
	env: Record<string, string | undefined>;
}

/**
 * Resolve an explicitly configured `rustc` path (`rust.interpreter` setting).
 */
export function resolveExplicitRustRuntime(
	interpreter: string,
	cwd: string,
	baseEnv: Record<string, string | undefined>,
): RustRuntime {
	const rustcPath = resolveExplicitPath(interpreter, cwd);
	return { rustcPath, env: filterEnv(baseEnv) };
}

/**
 * Enumerate candidate Rust runtimes in priority order.
 */
export function enumerateRustRuntimes(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): RustRuntime[] {
	return enumerateRuntimes(cwd, baseEnv, "rustc", (rustcPath, env) => ({ rustcPath, env }), interpreter);
}

/**
 * Resolve the highest-priority Rust runtime. Throws when none exists.
 */
export function resolveRustRuntime(
	cwd: string,
	baseEnv: Record<string, string | undefined>,
	interpreter?: string,
): RustRuntime {
	return resolveRuntime(cwd, baseEnv, "rustc", (rustcPath, env) => ({ rustcPath, env }), interpreter);
}
