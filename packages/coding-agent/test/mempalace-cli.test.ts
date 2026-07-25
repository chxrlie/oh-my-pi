import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CircuitBreaker, runMempalaceCli } from "@oh-my-pi/pi-coding-agent/mempalace/cli";

// Hermetic fixtures: shell stubs standing in for a real `python -m mempalace`.
let stubDir: string;
/** Echoes its argv on stdout, a marker on stderr, exits 0. */
let okStub: string;
/** Exits 3 — an installed binary reporting a genuine failure. */
let failStub: string;
/** Sleeps well past any test timeout so the runner must kill it. */
let hangStub: string;
/** Path that does not exist — spawning it raises ENOENT. */
let missingBin: string;

async function writeStub(name: string, body: string): Promise<string> {
	const file = path.join(stubDir, name);
	await fs.writeFile(file, `#!/bin/sh\n${body}`);
	await fs.chmod(file, 0o755);
	return file;
}

beforeAll(async () => {
	stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mempalace-cli-"));
	okStub = await writeStub("ok.sh", 'printf "ok:%s" "$*"\nprintf "note" >&2\nexit 0\n');
	failStub = await writeStub("fail.sh", 'printf "partial" \nprintf "boom" >&2\nexit 3\n');
	hangStub = await writeStub("hang.sh", "sleep 30\n");
	missingBin = path.join(stubDir, "not-installed");
});

afterAll(async () => {
	await fs.rm(stubDir, { recursive: true, force: true });
});

describe("CircuitBreaker", () => {
	it("stays closed below the failure threshold and opens on reaching it", () => {
		const now = 1_000;
		const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000, now: () => now });

		expect(breaker.open).toBe(false);
		breaker.recordFailure();
		breaker.recordFailure();
		expect(breaker.open).toBe(false);
		breaker.recordFailure();
		expect(breaker.open).toBe(true);
	});

	it("keeps the breaker open until the cooldown elapses, then half-opens", () => {
		let now = 0;
		const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 5_000, now: () => now });

		breaker.recordFailure();
		expect(breaker.open).toBe(true);

		now = 4_999;
		expect(breaker.open).toBe(true);

		now = 5_000;
		expect(breaker.open).toBe(false); // half-open: one probe may flow
	});

	it("re-trips immediately when the half-open probe fails", () => {
		let now = 0;
		const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 5_000, now: () => now });

		breaker.recordFailure();
		breaker.recordFailure();
		breaker.recordFailure();
		now = 5_000;
		expect(breaker.open).toBe(false);

		breaker.recordFailure();
		expect(breaker.open).toBe(true);

		now = 9_999;
		expect(breaker.open).toBe(true); // cooldown restarted at the re-trip
		now = 10_000;
		expect(breaker.open).toBe(false);
	});

	it("closes fully on success and requires a whole new streak to reopen", () => {
		let now = 0;
		const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 5_000, now: () => now });

		breaker.recordFailure();
		breaker.recordFailure();
		breaker.recordFailure();
		expect(breaker.open).toBe(true);

		now = 5_000;
		breaker.recordSuccess();
		expect(breaker.open).toBe(false);

		now = 6_000;
		breaker.recordFailure();
		breaker.recordFailure();
		expect(breaker.open).toBe(false); // streak reset, threshold not reached
		breaker.recordFailure();
		expect(breaker.open).toBe(true);
	});

	it("defaults to three failures before opening", () => {
		const breaker = new CircuitBreaker();
		breaker.recordFailure();
		breaker.recordFailure();
		expect(breaker.open).toBe(false);
		breaker.recordFailure();
		expect(breaker.open).toBe(true);
	});
});

describe("runMempalaceCli", () => {
	it("skips a missing candidate and runs the next one", async () => {
		const result = await runMempalaceCli(["status"], { candidates: [[missingBin], [okStub]] });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("ok:status");
		expect(result.command).toEqual([okStub, "status"]);
	});

	it("returns a nonzero exit from an existing binary instead of advancing", async () => {
		const result = await runMempalaceCli(["status"], { candidates: [[failStub], [okStub]] });

		expect(result.exitCode).toBe(3);
		expect(result.stderr).toBe("boom");
		expect(result.command).toEqual([failStub, "status"]);
		expect(result.stdout).not.toContain("ok:");
	});

	it("reports exit 127 with an explanation when every candidate is missing", async () => {
		const result = await runMempalaceCli(["status"], {
			candidates: [[missingBin], [`${missingBin}-2`, "-m", "mempalace"]],
		});

		expect(result.exitCode).toBe(127);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(missingBin);
		expect(result.stderr).toContain("pip install mempalace");
	});

	it("kills a hung child and reports exit 124 without waiting the child out", async () => {
		const started = Date.now();
		// The stub's `sleep 30` runs as a grandchild that inherits the pipes, so
		// this also pins that the runner stops reading rather than blocking on it.
		const result = await runMempalaceCli([], { candidates: [[hangStub]], timeoutMs: 150 });

		expect(result.exitCode).toBe(124);
		expect(result.stderr).toContain("timed out");
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("passes args through and merges opts.env over the parent environment", async () => {
		const echoEnv = await writeStub("env.sh", 'printf "%s|%s" "$MEMPALACE_TEST_VAR" "$1"\n');
		const result = await runMempalaceCli(["arg1"], {
			candidates: [[echoEnv]],
			env: { MEMPALACE_TEST_VAR: "injected" },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("injected|arg1");
	});

	it("runs in the requested cwd", async () => {
		const pwdStub = await writeStub("pwd.sh", "pwd\n");
		const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mempalace-cwd-"));
		try {
			const result = await runMempalaceCli([], { candidates: [[pwdStub]], cwd: workDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe(await fs.realpath(workDir));
		} finally {
			await fs.rm(workDir, { recursive: true, force: true });
		}
	});

	it("never throws when the candidate list is empty", async () => {
		const result = await runMempalaceCli(["status"], { candidates: [] });

		expect(result.exitCode).toBe(127);
		expect(result.stderr).toContain("mempalace CLI not found");
	});
});
