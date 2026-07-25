/**
 * Pure decision functions for the MemPalace memory backend.
 *
 * Nothing here touches the filesystem, spawns a process, or reads global state
 * beyond `process.env` as an explicit default — so every policy is trivially
 * testable and safe to call before any probe has run.
 */

import type { IngestTarget } from "./types";

/**
 * Decide which directory an auto-ingest run should target.
 *
 * Precedence: `MEMPALACE_DIR` > `MEMPAL_DIR` > `sessionFileDir` > `cwd`.
 *
 * - `MEMPALACE_DIR` is the omp-side canonical name for the ingest target.
 * - `MEMPAL_DIR` is the legacy alias used by the Python hooks; honored for
 *   compatibility but always loses to `MEMPALACE_DIR`.
 * - Neither names the palace *store*: that is `MEMPALACE_PALACE_PATH`, which is
 *   Python-owned and never set or interpreted by omp.
 *
 * Env values are trimmed; empty or whitespace-only values count as unset.
 * Directory existence is deliberately NOT checked here — this is a pure
 * decision function, and filtering unusable targets is the caller's concern.
 *
 * @param input.env Env map to consult; defaults to `process.env`.
 * @param input.sessionFileDir Directory of the current session file, when known.
 * @param input.cwd Last-resort target, flagged `source: "cwd"`.
 */
export function resolveIngestTarget(input: {
	env?: Record<string, string | undefined>;
	sessionFileDir?: string;
	cwd: string;
}): IngestTarget {
	const env = input.env ?? process.env;
	const envDir = (env.MEMPALACE_DIR ?? "").trim() || (env.MEMPAL_DIR ?? "").trim();
	if (envDir) return { dir: envDir, source: "env" };

	const sessionDir = (input.sessionFileDir ?? "").trim();
	if (sessionDir) return { dir: sessionDir, source: "session" };

	return { dir: input.cwd, source: "cwd" };
}

/**
 * Whether a completed ingest run counts as satisfying memory preservation.
 *
 * Requires a clean exit *and* a deliberate target: a `cwd` fallback is the
 * unsafe last resort and never counts, even when the run succeeded.
 */
export function isPreservationSatisfied(input: { exitCode: number; target: IngestTarget }): boolean {
	return input.exitCode === 0 && input.target.source !== "cwd";
}
