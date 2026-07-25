import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import { mempalaceBackend, resetProbeForTests } from "@oh-my-pi/pi-coding-agent/mempalace";

/**
 * An empty directory as the sole PATH entry: every `python3`/`python` lookup
 * fails with ENOENT, which is exactly the "no Python installed" machine the
 * backend must survive. The probe snapshots `process.env` per spawn, so this
 * pins the degraded branch without depending on the host's real Python.
 */
let emptyPathDir: string;
let originalPath: string | undefined;

describe("mempalace memory backend wiring", () => {
	beforeEach(() => {
		resetSettingsForTest();
		resetProbeForTests();
		emptyPathDir = mkdtempSync(path.join(tmpdir(), "mempalace-nopath-"));
		originalPath = process.env.PATH;
	});

	afterEach(() => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		rmSync(emptyPathDir, { recursive: true, force: true });
		resetProbeForTests();
		resetSettingsForTest();
	});

	it("resolves the mempalace backend when memory.backend is mempalace", async () => {
		const settings = Settings.isolated({ "memory.backend": "mempalace" });
		const backend = await resolveMemoryBackend(settings);
		expect(backend.id).toBe("mempalace");
		expect(backend).toBe(mempalaceBackend);
	});

	it("reports an inactive, actionable status when no Python is on PATH", async () => {
		process.env.PATH = emptyPathDir;

		const status = await mempalaceBackend.status?.({ agentDir: "/tmp/agent", cwd: "/tmp/project" });

		expect(status).toMatchObject({
			backend: "mempalace",
			active: false,
			writable: false,
			searchable: false,
		});
		expect(status?.message).toContain("pip install mempalace");
		expect(status?.error).toContain("No Python interpreter");
	});

	it("stays inert without throwing when the environment is unusable", async () => {
		process.env.PATH = emptyPathDir;
		const settings = Settings.isolated({ "memory.backend": "mempalace" });

		const instructions = await mempalaceBackend.buildDeveloperInstructions("/tmp/agent", settings);
		expect(instructions).toBeUndefined();
		await expect(mempalaceBackend.clear("/tmp/agent", "/tmp/project")).resolves.toBeUndefined();
		await expect(mempalaceBackend.enqueue("/tmp/agent", "/tmp/project")).resolves.toBeUndefined();
	});
});
