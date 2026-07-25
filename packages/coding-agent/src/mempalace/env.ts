/**
 * Python environment probing for the MemPalace backend.
 *
 * Everything here is best-effort and non-throwing: omp must start and run
 * normally on machines with no Python at all, so a failed probe degrades to a
 * `MempalaceProbe` carrying a human-readable `detail` instead of an exception.
 */

import type { MempalaceProbe } from "./types";

/** Hard cap per spawned probe command — a wedged interpreter must not stall startup. */
const PROBE_TIMEOUT_MS = 10_000;

/** Launcher candidates, in preference order. First one that answers `--version` wins. */
const PYTHON_CANDIDATES = ["python3", "python"] as const;

/** Import probe: prints the package version (empty string when it has none). */
const IMPORT_PROBE = "import mempalace,sys;sys.stdout.write(getattr(mempalace,'__version__',''))";

let probeCache: Promise<MempalaceProbe> | undefined;

interface RunOutcome {
	ok: boolean;
	stdout: string;
	stderr: string;
}

async function run(cmd: string[]): Promise<RunOutcome> {
	try {
		const proc = Bun.spawn(cmd, {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			// Snapshot the live environment explicitly: Bun resolves the executable
			// against the inherited environ, not `process.env`, so a PATH mutated at
			// runtime (direnv, tests) would otherwise be ignored during lookup.
			env: { ...process.env },
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		// Drain both pipes concurrently — a chatty interpreter can otherwise fill
		// stderr and block until the timeout fires.
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
		]);
		const exitCode = await proc.exited;
		return { ok: exitCode === 0, stdout, stderr };
	} catch (error) {
		// Missing binary (ENOENT) and abort both land here.
		return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

async function detect(): Promise<MempalaceProbe> {
	let pythonCommand: string | undefined;
	for (const candidate of PYTHON_CANDIDATES) {
		if ((await run([candidate, "--version"])).ok) {
			pythonCommand = candidate;
			break;
		}
	}
	if (!pythonCommand) {
		return {
			pythonCommand: undefined,
			installed: false,
			detail: `No Python interpreter on PATH (tried ${PYTHON_CANDIDATES.join(", ")}).`,
		};
	}

	const imported = await run([pythonCommand, "-c", IMPORT_PROBE]);
	if (!imported.ok) {
		const reason = imported.stderr.trim().split("\n", 1)[0]?.trim();
		return {
			pythonCommand,
			installed: false,
			detail: `\`${pythonCommand}\` cannot import the mempalace package${reason ? `: ${reason}` : "."}`,
		};
	}
	const version = imported.stdout.trim();
	return { pythonCommand, installed: true, version: version || undefined };
}

/**
 * Probe the local Python environment for the `mempalace` package.
 *
 * Cached after the first call for the lifetime of the process — the answer only
 * changes when the user installs something, and every caller is on a hot path
 * (status rendering, transport startup). Never rejects.
 */
export function probeMempalace(): Promise<MempalaceProbe> {
	probeCache ??= detect().catch(error => ({
		pythonCommand: undefined,
		installed: false,
		detail: `MemPalace probe failed: ${error instanceof Error ? error.message : String(error)}`,
	}));
	return probeCache;
}

/** Drop the cached probe so a test can re-probe under a different environment. */
export function resetProbeForTests(): void {
	probeCache = undefined;
}
