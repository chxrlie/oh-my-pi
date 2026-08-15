/**
 * Single-shot Rust executor: compiles and runs each eval cell as a standalone
 * Rust program via `rustc`. No persistent state — every cell starts fresh.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import type { EvalDisplayOutput } from "../types";
import { RUST_PRELUDE } from "./prelude";
import { filterEnv } from "./runtime";

export interface RustExecutorOptions {
	cwd: string;
	signal?: AbortSignal;
	/** Runtime-work budget (ms); used only for the timeout annotation. */
	idleTimeoutMs?: number;
	/** Explicit rustc path; skips discovery when set. */
	interpreter?: string;
	onChunk: (chunk: string) => void;
	artifactsDir?: string;
	localRoots?: Record<string, string>;
	/** Base environment from the session. */
	sessionEnv?: Record<string, string | undefined>;
}

export interface RustResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId: string | undefined;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: EvalDisplayOutput[];
}

/**
 * Assemble a complete Rust source file: prelude module + user code in a main().
 */
function assembleSource(userCode: string): string {
	const lines = [
		RUST_PRELUDE,
		"",
		"// ── User code ──",
		"use omp_prelude::*;",
		"",
		"fn main() {",
	];
	for (const line of userCode.split("\n")) {
		lines.push(`    ${line}`);
	}
	lines.push("}");
	return lines.join("\n");
}

interface ProcOutput {
	stdout: string;
	stderr: string;
}

async function readSubprocessOutput(
	proc: Subprocess<"pipe", "pipe">,
	signal?: AbortSignal,
): Promise<ProcOutput> {
	const decoder = new TextDecoder();
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];

	const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();

	let aborted = false;
	const onAbort = () => {
		aborted = true;
		try { proc.kill(); } catch { /* ignore */ }
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	const readStream = async (
		reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; releaseLock(): void },
		chunks: string[],
	) => {
		try {
			while (!aborted) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) chunks.push(decoder.decode(value, { stream: true }));
			}
		} catch {
			// stream closed or errored
		} finally {
			try { reader.releaseLock(); } catch { /* ignore */ }
		}
	};

	await Promise.all([
		readStream(stdoutReader, stdoutChunks),
		readStream(stderrReader, stderrChunks),
		proc.exited,
	]);

	signal?.removeEventListener("abort", onAbort);

	// Flush decoder
	const stdout = decoder.decode(new Uint8Array()) + stdoutChunks.join("");
	const stderr = stderrChunks.join("");

	return {
		stdout: stdout.trimEnd(),
		stderr: stderr.trimEnd(),
	};
}

function buildResult(
	output: string,
	exitCode: number | undefined,
	cancelled: boolean,
): RustResult {
	const lines = output.split("\n");
	return {
		output,
		exitCode,
		cancelled,
		truncated: false,
		artifactId: undefined,
		totalLines: lines.length,
		totalBytes: Buffer.byteLength(output, "utf-8"),
		outputLines: lines.length,
		outputBytes: Buffer.byteLength(output, "utf-8"),
		displayOutputs: [],
	};
}

/**
 * Execute Rust code by writing a temp file, compiling with `rustc`, and
 * running the resulting binary.
 */
export async function executeRust(
	code: string,
	options: RustExecutorOptions,
): Promise<RustResult> {
	const { cwd, signal, interpreter, onChunk, localRoots, sessionEnv } = options;

	const rustcPath = interpreter ?? "rustc";
	const source = assembleSource(code);

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rust-"));
	const srcPath = path.join(tmpDir, "main.rs");
	const binPath = path.join(tmpDir, "main");

	fs.writeFileSync(srcPath, source, "utf-8");

	// Build environment
	const env: Record<string, string> = {};
	if (sessionEnv) {
		for (const [key, value] of Object.entries(filterEnv(sessionEnv))) {
			if (typeof value === "string") env[key] = value;
		}
	}
	if (localRoots) {
		env.PI_EVAL_LOCAL_ROOTS = JSON.stringify(localRoots);
	}

	let cancelled = false;

	const onAbort = () => {
		cancelled = true;
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		// Phase 1: Compile
		const compileStart = Date.now();
		const compileProc = Bun.spawn([rustcPath, "-o", binPath, "--edition", "2021", "--crate-type", "bin", "--crate-name", "omp_eval", srcPath], {
			cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		const compileOutput = await readSubprocessOutput(compileProc, signal);
		const compileMs = Date.now() - compileStart;

		if (compileProc.exitCode !== 0) {
			const errText = compileOutput.stderr || compileOutput.stdout;
			onChunk(errText);
			return buildResult(errText, compileProc.exitCode ?? 1, cancelled);
		}

		if (compileMs > 2000) {
			onChunk(`// compiled in ${compileMs}ms\n`);
		}

		if (signal?.aborted) {
			return buildResult("", undefined, true);
		}

		// Phase 2: Run
		const runEnv: Record<string, string> = {};
		if (sessionEnv) {
			for (const [key, value] of Object.entries(filterEnv(sessionEnv))) {
				if (typeof value === "string") runEnv[key] = value;
			}
		}
		if (localRoots) {
			runEnv.PI_EVAL_LOCAL_ROOTS = JSON.stringify(localRoots);
		}

		const runProc = Bun.spawn([binPath], {
			cwd,
			env: runEnv,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		const runOutput = await readSubprocessOutput(runProc, signal);

		const parts: string[] = [];
		if (compileOutput.stderr) parts.push(`// compile stderr:\n${compileOutput.stderr}`);
		if (runOutput.stdout) parts.push(runOutput.stdout);
		if (runOutput.stderr) parts.push(`// stderr:\n${runOutput.stderr}`);
		const combined = parts.join("\n");

		onChunk(combined);

		return buildResult(
			combined,
			runProc.exitCode ?? 0,
			cancelled || signal?.aborted === true,
		);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	}
}
