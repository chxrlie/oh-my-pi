/**
 * MemPalace CLI transport: a launcher-fallback runner plus the circuit breaker
 * that keeps a broken/absent Python install from being re-probed on every turn.
 *
 * Nothing here throws. The mempalace backend is optional infrastructure — when
 * Python or the package is missing, every call degrades to a `CliRunResult`
 * whose exit code explains the failure.
 */

/** Launcher prefixes tried in order; the first one that actually spawns wins. */
const DEFAULT_CANDIDATES: readonly (readonly string[])[] = [
	["python3", "-m", "mempalace"],
	["python", "-m", "mempalace"],
	["mempalace"],
];

/** Exit code convention borrowed from `timeout(1)`: the child hit the wall clock. */
const EXIT_TIMEOUT = 124;
/** Exit code convention borrowed from POSIX shells: no runnable command. */
const EXIT_NOT_FOUND = 127;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Grace period between the polite SIGTERM and the guaranteed SIGKILL. */
const KILL_ESCALATION_MS = 2_000;

/**
 * Trip-and-cool-down guard around a flaky dependency.
 *
 * Closed → counts consecutive failures; at `failureThreshold` it trips open.
 * Open → `open` stays true until `cooldownMs` has elapsed, after which the
 * breaker half-opens (`open === false`) so exactly one probe call can flow. A
 * failure from that probe re-trips immediately; a success closes it fully.
 */
export class CircuitBreaker {
	readonly #failureThreshold: number;
	readonly #cooldownMs: number;
	readonly #now: () => number;
	#failures = 0;
	#trippedAt: number | undefined;

	constructor(opts?: { failureThreshold?: number; cooldownMs?: number; now?: () => number }) {
		this.#failureThreshold = Math.max(1, opts?.failureThreshold ?? 3);
		this.#cooldownMs = Math.max(0, opts?.cooldownMs ?? 60_000);
		this.#now = opts?.now ?? Date.now;
	}

	/** True while tripped and the cooldown has not yet elapsed. */
	get open(): boolean {
		if (this.#trippedAt === undefined) return false;
		return this.#now() - this.#trippedAt < this.#cooldownMs;
	}

	/** Closes the breaker and forgets the failure streak. */
	recordSuccess(): void {
		this.#failures = 0;
		this.#trippedAt = undefined;
	}

	/** Counts a failure; trips at the threshold, or re-trips a half-open breaker. */
	recordFailure(): void {
		if (this.#trippedAt !== undefined && !this.open) {
			// Half-open probe failed: straight back to open for a full cooldown.
			this.#failures = this.#failureThreshold;
			this.#trippedAt = this.#now();
			return;
		}
		this.#failures += 1;
		if (this.#failures >= this.#failureThreshold) this.#trippedAt = this.#now();
	}
}

export interface CliRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** Full argv of the candidate that actually ran (or the last one attempted). */
	command: string[];
}

/** Bun surfaces a missing executable as a synchronous throw carrying ENOENT. */
function isMissingBinary(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	if ("code" in err) return err.code === "ENOENT";
	// Older Bun builds report a PATH miss without a `code` field.
	return err instanceof Error && err.message.includes("Executable not found");
}

/**
 * Run the mempalace CLI, falling back across launcher candidates.
 *
 * A candidate is skipped ONLY when its binary is missing (spawn ENOENT) — a
 * real nonzero exit from an existing binary is a genuine answer and is returned
 * as-is rather than masked by trying the next launcher. When every candidate is
 * missing the result is exit 127 with a stderr that names what was tried.
 * Exceeding `timeoutMs` (default 30s) kills the child and yields exit 124.
 *
 * Never throws.
 */
export async function runMempalaceCli(
	args: string[],
	opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; candidates?: string[][] },
): Promise<CliRunResult> {
	const candidates: readonly (readonly string[])[] = opts?.candidates ?? DEFAULT_CANDIDATES;
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const env = opts?.env ? { ...process.env, ...opts.env } : process.env;

	const missing: string[] = [];
	let lastCommand: string[] = [...args];

	for (const candidate of candidates) {
		if (candidate.length === 0) continue;
		const command = [...candidate, ...args];
		lastCommand = command;

		let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			proc = Bun.spawn(command, {
				cwd: opts?.cwd,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
		} catch (err) {
			if (isMissingBinary(err)) {
				missing.push(candidate.join(" "));
				continue;
			}
			// Present but unusable (EACCES, bad interpreter, …): a real failure,
			// and trying the next launcher would only hide it.
			return {
				exitCode: EXIT_NOT_FOUND,
				stdout: "",
				stderr: `failed to spawn ${candidate.join(" ")}: ${err instanceof Error ? err.message : String(err)}`,
				command,
			};
		}

		return await collect(proc, command, timeoutMs);
	}

	const tried = missing.length > 0 ? missing.join(", ") : "(no candidates configured)";
	return {
		exitCode: EXIT_NOT_FOUND,
		stdout: "",
		stderr: `mempalace CLI not found — tried: ${tried}. Install it with \`pip install mempalace\`.`,
		command: lastCommand,
	};
}

async function collect(
	proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
	command: string[],
	timeoutMs: number,
): Promise<CliRunResult> {
	const stdoutReader = proc.stdout.getReader();
	const stderrReader = proc.stderr.getReader();
	// Drain both pipes concurrently: reading only stdout deadlocks any child
	// that fills the stderr buffer.
	const finished: Promise<CliRunResult> = Promise.all([pump(stdoutReader), pump(stderrReader)]).then(
		async ([stdout, stderr]) => ({ exitCode: await proc.exited, stdout, stderr, command }),
		(err: unknown) => ({
			exitCode: 1,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			command,
		}),
	);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await finished;

	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<CliRunResult>(resolve => {
		timer = setTimeout(() => {
			proc.kill();
			setTimeout(() => proc.kill("SIGKILL"), KILL_ESCALATION_MS).unref();
			// Cancel the reads instead of waiting them out: a grandchild that
			// inherited the pipes outlives its killed parent and would otherwise
			// hold both the fds and the event loop for its full runtime.
			stdoutReader.cancel().catch(() => {});
			stderrReader.cancel().catch(() => {});
			proc.unref();
			resolve({
				exitCode: EXIT_TIMEOUT,
				stdout: "",
				stderr: `mempalace CLI timed out after ${timeoutMs}ms: ${command.join(" ")}`,
				command,
			});
		}, timeoutMs);
		timer.unref();
	});

	try {
		return await Promise.race([finished, expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** Reads one subprocess pipe to EOF; a cancelled reader ends the loop cleanly. */
async function pump(reader: {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(): Promise<unknown>;
}): Promise<string> {
	const decoder = new TextDecoder();
	let out = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) out += decoder.decode(value as unknown as Uint8Array, { stream: true });
	}
	return out + decoder.decode();
}
