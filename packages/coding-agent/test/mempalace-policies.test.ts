import { describe, expect, it } from "bun:test";
import { isPreservationSatisfied, resolveIngestTarget } from "@oh-my-pi/pi-coding-agent/mempalace/policies";
import type { IngestTarget } from "@oh-my-pi/pi-coding-agent/mempalace/types";

describe("resolveIngestTarget", () => {
	it("prefers MEMPALACE_DIR over the MEMPAL_DIR legacy alias", () => {
		expect(
			resolveIngestTarget({
				env: { MEMPALACE_DIR: "/canonical", MEMPAL_DIR: "/legacy" },
				sessionFileDir: "/session",
				cwd: "/cwd",
			}),
		).toEqual({ dir: "/canonical", source: "env" });
	});

	it("honors MEMPAL_DIR when the canonical name is unset", () => {
		expect(resolveIngestTarget({ env: { MEMPAL_DIR: "/legacy" }, sessionFileDir: "/session", cwd: "/cwd" })).toEqual({
			dir: "/legacy",
			source: "env",
		});
	});

	it("falls through empty and whitespace-only env values", () => {
		expect(
			resolveIngestTarget({
				env: { MEMPALACE_DIR: "   ", MEMPAL_DIR: "" },
				sessionFileDir: "/session",
				cwd: "/cwd",
			}),
		).toEqual({ dir: "/session", source: "session" });
	});

	it("falls back from a blank canonical value to the legacy alias", () => {
		expect(resolveIngestTarget({ env: { MEMPALACE_DIR: "\t\n", MEMPAL_DIR: "/legacy" }, cwd: "/cwd" })).toEqual({
			dir: "/legacy",
			source: "env",
		});
	});

	it("trims surrounding whitespace off env values", () => {
		expect(resolveIngestTarget({ env: { MEMPALACE_DIR: "  /canonical  " }, cwd: "/cwd" })).toEqual({
			dir: "/canonical",
			source: "env",
		});
	});

	it("uses the session file directory when no env override is set", () => {
		expect(resolveIngestTarget({ env: {}, sessionFileDir: " /session ", cwd: "/cwd" })).toEqual({
			dir: "/session",
			source: "session",
		});
	});

	it("falls back to cwd when nothing else is usable", () => {
		expect(resolveIngestTarget({ env: {}, sessionFileDir: "  ", cwd: "/cwd" })).toEqual({
			dir: "/cwd",
			source: "cwd",
		});
	});

	it("leaves cwd untrimmed and unvalidated (pure decision, no filesystem check)", () => {
		expect(resolveIngestTarget({ env: {}, cwd: "/does/not/exist" })).toEqual({
			dir: "/does/not/exist",
			source: "cwd",
		});
	});

	it("never consults process.env when an explicit env object is passed", () => {
		const previous = process.env.MEMPALACE_DIR;
		process.env.MEMPALACE_DIR = "/from-process-env";
		try {
			expect(resolveIngestTarget({ env: {}, sessionFileDir: "/session", cwd: "/cwd" })).toEqual({
				dir: "/session",
				source: "session",
			});
			expect(resolveIngestTarget({ env: {}, cwd: "/cwd" })).toEqual({ dir: "/cwd", source: "cwd" });
		} finally {
			if (previous === undefined) delete process.env.MEMPALACE_DIR;
			else process.env.MEMPALACE_DIR = previous;
		}
	});

	it("defaults to process.env when no env object is given", () => {
		const previous = process.env.MEMPALACE_DIR;
		process.env.MEMPALACE_DIR = "/from-process-env";
		try {
			expect(resolveIngestTarget({ sessionFileDir: "/session", cwd: "/cwd" })).toEqual({
				dir: "/from-process-env",
				source: "env",
			});
		} finally {
			if (previous === undefined) delete process.env.MEMPALACE_DIR;
			else process.env.MEMPALACE_DIR = previous;
		}
	});
});

describe("isPreservationSatisfied", () => {
	const target = (source: IngestTarget["source"]): IngestTarget => ({ dir: "/target", source });

	it("is satisfied by a clean run against an env target", () => {
		expect(isPreservationSatisfied({ exitCode: 0, target: target("env") })).toBe(true);
	});

	it("is satisfied by a clean run against a session target", () => {
		expect(isPreservationSatisfied({ exitCode: 0, target: target("session") })).toBe(true);
	});

	it("rejects a clean run against the cwd last resort", () => {
		expect(isPreservationSatisfied({ exitCode: 0, target: target("cwd") })).toBe(false);
	});

	it("rejects a failed run even against a deliberate target", () => {
		expect(isPreservationSatisfied({ exitCode: 1, target: target("env") })).toBe(false);
		expect(isPreservationSatisfied({ exitCode: 127, target: target("session") })).toBe(false);
		expect(isPreservationSatisfied({ exitCode: 124, target: target("cwd") })).toBe(false);
	});
});
