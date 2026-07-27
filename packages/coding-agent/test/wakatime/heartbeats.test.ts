import { describe, expect, it } from "bun:test";
import {
	createHeartbeatEmitter,
	type ExecFn,
	type HeartbeatEmitter,
	type WakatimeConfig,
} from "@oh-my-pi/pi-coding-agent/wakatime";

const CLI = "/usr/local/bin/wakatime-cli";
const CWD = "/tmp/wakatime-workspace";
const PLUGIN = "oh-my-pi/17.1.3 omp-wakatime/1";

const CONFIG: WakatimeConfig = { cliPath: CLI, apiKey: "key", apiUrl: "https://api.wakatime.com/api/v1" };

interface ExecCall {
	command: string;
	args: string[];
	cwd: string;
}

interface FakeExec {
	fn: ExecFn;
	readonly calls: ExecCall[];
}

function fakeExec(): FakeExec {
	const calls: ExecCall[] = [];
	return {
		calls,
		fn: async (command, args, cwd) => {
			calls.push({ command, args, cwd });
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};
}

/** `--entity` values in call order, so assertions read as "which files were sent". */
function entities(calls: readonly ExecCall[]): string[] {
	return calls.map(call => call.args[call.args.indexOf("--entity") + 1]);
}

function emitterWith(exec: ExecFn, overrides: { config?: WakatimeConfig; throttleMs?: number } = {}): HeartbeatEmitter {
	return createHeartbeatEmitter({
		config: overrides.config ?? CONFIG,
		cwd: CWD,
		pluginId: PLUGIN,
		throttleMs: overrides.throttleMs,
		exec,
	});
}

describe("createHeartbeatEmitter", () => {
	it("sends a read heartbeat with the plugin, category, and cwd", async () => {
		const exec = fakeExec();
		const emitter = emitterWith(exec.fn);

		emitter.record("/repo/src/a.ts", "read");
		await emitter.flush();

		expect(exec.calls).toHaveLength(1);
		expect(exec.calls[0].command).toBe(CLI);
		expect(exec.calls[0].cwd).toBe(CWD);
		expect(exec.calls[0].args).toEqual(["--entity", "/repo/src/a.ts", "--plugin", PLUGIN, "--category", "ai coding"]);
	});

	it("throttles a repeated read of the same path inside the window", async () => {
		const exec = fakeExec();
		const emitter = emitterWith(exec.fn, { throttleMs: 60_000 });

		emitter.record("/repo/src/a.ts", "read");
		emitter.record("/repo/src/a.ts", "read");
		emitter.record("/repo/src/a.ts", "read");
		await emitter.flush();

		expect(entities(exec.calls)).toEqual(["/repo/src/a.ts"]);
	});

	it("throttles per path, not globally", async () => {
		const exec = fakeExec();
		const emitter = emitterWith(exec.fn, { throttleMs: 60_000 });

		emitter.record("/repo/src/a.ts", "read");
		emitter.record("/repo/src/b.ts", "read");
		emitter.record("/repo/src/a.ts", "read");
		await emitter.flush();

		expect(entities(exec.calls)).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"]);
	});

	it("sends a read again once the throttle window has elapsed", async () => {
		const exec = fakeExec();
		// A zero-length window makes every read immediately eligible again.
		const emitter = emitterWith(exec.fn, { throttleMs: 0 });

		emitter.record("/repo/src/a.ts", "read");
		emitter.record("/repo/src/a.ts", "read");
		await emitter.flush();

		expect(entities(exec.calls)).toEqual(["/repo/src/a.ts", "/repo/src/a.ts"]);
	});

	it("never throttles writes", async () => {
		const exec = fakeExec();
		const emitter = emitterWith(exec.fn, { throttleMs: 60_000 });

		emitter.record("/repo/src/a.ts", "write");
		emitter.record("/repo/src/a.ts", "write");
		emitter.record("/repo/src/a.ts", "write");
		await emitter.flush();

		expect(entities(exec.calls)).toEqual(["/repo/src/a.ts", "/repo/src/a.ts", "/repo/src/a.ts"]);
	});

	it("passes --write only for writes", async () => {
		const exec = fakeExec();
		const emitter = emitterWith(exec.fn, { throttleMs: 60_000 });

		emitter.record("/repo/src/a.ts", "write");
		emitter.record("/repo/src/b.ts", "read");
		await emitter.flush();

		expect(exec.calls[0].args).toContain("--write");
		expect(exec.calls[1].args).not.toContain("--write");
	});

	it("honours a custom category", async () => {
		const exec = fakeExec();
		const emitter = createHeartbeatEmitter({
			config: CONFIG,
			cwd: CWD,
			pluginId: PLUGIN,
			category: "code reviewing",
			exec: exec.fn,
		});

		emitter.record("/repo/src/a.ts", "read");
		await emitter.flush();

		expect(exec.calls[0].args).toEqual([
			"--entity",
			"/repo/src/a.ts",
			"--plugin",
			PLUGIN,
			"--category",
			"code reviewing",
		]);
	});

	it("never passes --project, leaving projectmap and .wakatime-project in charge", async () => {
		const exec = fakeExec();
		const emitter = emitterWith(exec.fn);

		emitter.record("/repo/src/a.ts", "write");
		await emitter.flush();

		expect(exec.calls[0].args).not.toContain("--project");
	});

	it("sends nothing when no wakatime-cli is installed", async () => {
		const exec = fakeExec();
		const emitter = emitterWith(exec.fn, {
			config: { cliPath: null, apiKey: "key", apiUrl: "https://api.wakatime.com/api/v1" },
		});

		emitter.record("/repo/src/a.ts", "read");
		emitter.record("/repo/src/b.ts", "write");
		await emitter.flush();

		expect(exec.calls).toEqual([]);
	});

	it("stays silent when the CLI fails", async () => {
		const emitter = emitterWith(async () => {
			throw new Error("spawn ENOENT");
		});

		emitter.record("/repo/src/a.ts", "write");
		await emitter.flush();
	});

	it("flush resolves only after in-flight sends settle", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		let settled = false;
		const emitter = emitterWith(async () => {
			await gate;
			settled = true;
			return { stdout: "", stderr: "", code: 0, killed: false };
		});

		emitter.record("/repo/src/a.ts", "write");
		const flushed = emitter.flush();
		expect(settled).toBe(false);

		release?.();
		await flushed;
		expect(settled).toBe(true);
	});
});
