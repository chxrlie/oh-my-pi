import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	classifyToolActivity,
	extractToolPaths,
	type HeartbeatEmitter,
	type TrackedActivity,
	withWakatimeTracking,
} from "@oh-my-pi/pi-coding-agent/wakatime";
import { type } from "arktype";

const CWD = path.resolve("/tmp", "wakatime-workspace");

/** Absolute path under the fixture workspace, so expectations stay platform-neutral. */
function inCwd(...segments: string[]): string {
	return path.join(CWD, ...segments);
}

interface SentHeartbeat {
	path: string;
	activity: TrackedActivity;
}

function collectingEmitter(): HeartbeatEmitter & { readonly sent: SentHeartbeat[] } {
	const sent: SentHeartbeat[] = [];
	return {
		sent,
		record(absolutePath, activity) {
			sent.push({ path: absolutePath, activity });
		},
		async flush() {},
	};
}

const OK_RESULT: AgentToolResult = { content: [{ type: "text", text: "ok" }] };

// Stands in for the arg shapes of every tool under test: `path` covers the
// file tools, `content`/`command` the write and bash payloads.
const FAKE_SCHEMA = type({ "path?": "string", "content?": "string", "command?": "string" });

/**
 * A tool carrying the full metadata surface `withWakatimeTracking` must leave
 * intact — including an arrow-function `approval` like the real `EditTool`.
 */
function makeTool(name: string, execute: (params: unknown) => Promise<AgentToolResult>): AgentTool<typeof FAKE_SCHEMA> {
	return {
		name,
		label: "Fake",
		description: "fake tool",
		parameters: FAKE_SCHEMA,
		strict: true,
		loadMode: "essential",
		summary: "fake summary",
		approval: () => "write",
		execute: (_toolCallId, params) => execute(params),
	};
}

describe("classifyToolActivity", () => {
	it("maps the file-reading tools to read", () => {
		for (const name of ["read", "glob", "grep", "ast_grep"]) {
			expect(classifyToolActivity(name)).toBe("read");
		}
	});

	it("maps the file-mutating tools to write", () => {
		for (const name of ["write", "edit", "ast_edit"]) {
			expect(classifyToolActivity(name)).toBe("write");
		}
	});

	it("returns null for tools that touch no files", () => {
		for (const name of ["bash", "todo", "task", "web_search", ""]) {
			expect(classifyToolActivity(name)).toBeNull();
		}
	});

	it("does not resolve inherited Object properties as tools", () => {
		// Tool names arrive from the model; a bare index would hit the prototype.
		for (const name of ["constructor", "toString", "hasOwnProperty"]) {
			expect(classifyToolActivity(name)).toBeNull();
		}
	});
});

describe("extractToolPaths", () => {
	it("strips a line selector from a read path", () => {
		expect(extractToolPaths("read", { path: "src/foo.ts:50-200" }, CWD)).toEqual([inCwd("src/foo.ts")]);
	});

	it("keeps a read path that has no selector", () => {
		expect(extractToolPaths("read", { path: "src/foo.ts" }, CWD)).toEqual([inCwd("src/foo.ts")]);
	});

	it("splits the semicolon-delimited list glob and grep accept", () => {
		expect(extractToolPaths("glob", { path: "src; tests" }, CWD)).toEqual([inCwd("src"), inCwd("tests")]);
		expect(extractToolPaths("grep", { pattern: "x", path: "src; tests" }, CWD)).toEqual([
			inCwd("src"),
			inCwd("tests"),
		]);
	});

	it("does not split a semicolon inside an exact write path", () => {
		expect(extractToolPaths("write", { path: "notes;draft.md", content: "" }, CWD)).toEqual([
			inCwd("notes;draft.md"),
		]);
	});

	it("trims a glob tail on scope tools so the entity is a real directory", () => {
		expect(extractToolPaths("glob", { path: "src/**/*.ts" }, CWD)).toEqual([inCwd("src")]);
	});

	it("resolves relative paths against cwd and leaves absolute paths alone", () => {
		expect(extractToolPaths("read", { path: "foo.ts" }, CWD)).toEqual([inCwd("foo.ts")]);
		const absolute = path.resolve("/var", "tmp", "other.ts");
		expect(extractToolPaths("read", { path: absolute }, CWD)).toEqual([absolute]);
	});

	it("rejects internal URLs and web URLs", () => {
		const rejected = [
			"skill://align-grid",
			"agent://WakatimeCore",
			"artifact://44",
			"memory://notes",
			"issue://12",
			"pr://12",
			"mcp://server/res",
			"ssh://host/etc/hosts",
			"local://plan.md",
			"history://abc",
			"vault://notes/a.md",
			"xd://ast_grep",
			"https://example.com/a.ts",
			"http://example.com/a.ts",
		];
		for (const target of rejected) {
			expect(extractToolPaths("read", { path: target }, CWD)).toEqual([]);
		}
	});

	it("drops internal URLs from a mixed semicolon list but keeps the real paths", () => {
		expect(extractToolPaths("grep", { pattern: "x", path: "src; skill://foo; tests" }, CWD)).toEqual([
			inCwd("src"),
			inCwd("tests"),
		]);
	});

	it("reads the paths array ast_edit uses", () => {
		expect(extractToolPaths("ast_edit", { ops: [], paths: ["src/a.ts", "src/b.ts"] }, CWD)).toEqual([
			inCwd("src/a.ts"),
			inCwd("src/b.ts"),
		]);
	});

	it("parses [PATH#TAG] section headers out of an edit patch body", () => {
		const input = ["[src/a.ts#A1B2]", "SWAP 1.=1:", "+const a = 1;", "[src/b.ts#C3D4]", "DEL 4"].join("\n");
		expect(extractToolPaths("edit", { input }, CWD)).toEqual([inCwd("src/a.ts"), inCwd("src/b.ts")]);
	});

	it("parses an untagged edit section header", () => {
		expect(extractToolPaths("edit", { input: "[src/a.ts]\nDEL 1" }, CWD)).toEqual([inCwd("src/a.ts")]);
	});

	it("parses apply_patch envelope headers out of an edit body", () => {
		const input = ["*** Begin Patch", "*** Update File: src/app.py", "+x = 1", "*** End Patch"].join("\n");
		expect(extractToolPaths("edit", { input }, CWD)).toEqual([inCwd("src/app.py")]);
	});

	it("deduplicates repeated targets", () => {
		const input = "[src/a.ts#A1B2]\nDEL 1\n[src/a.ts#A1B2]\nDEL 9";
		expect(extractToolPaths("edit", { input }, CWD)).toEqual([inCwd("src/a.ts")]);
		expect(extractToolPaths("glob", { path: "src; src" }, CWD)).toEqual([inCwd("src")]);
	});

	it("returns [] when nothing applies", () => {
		expect(extractToolPaths("bash", { command: "ls" }, CWD)).toEqual([]);
		expect(extractToolPaths("grep", { pattern: "x" }, CWD)).toEqual([]);
		expect(extractToolPaths("read", null, CWD)).toEqual([]);
		expect(extractToolPaths("read", "src/foo.ts", CWD)).toEqual([]);
		expect(extractToolPaths("read", { path: "   " }, CWD)).toEqual([]);
		expect(extractToolPaths("edit", { input: "no headers here" }, CWD)).toEqual([]);
	});
});

describe("withWakatimeTracking", () => {
	it("emits one heartbeat per extracted path after a successful call", async () => {
		const emitter = collectingEmitter();
		const tool = withWakatimeTracking(
			makeTool("glob", async () => OK_RESULT),
			emitter,
			CWD,
		);

		await tool.execute("call-1", { path: "src; tests" });

		expect(emitter.sent).toEqual([
			{ path: inCwd("src"), activity: "read" },
			{ path: inCwd("tests"), activity: "read" },
		]);
	});

	it("records write activity for mutating tools", async () => {
		const emitter = collectingEmitter();
		const tool = withWakatimeTracking(
			makeTool("write", async () => OK_RESULT),
			emitter,
			CWD,
		);

		await tool.execute("call-1", { path: "src/a.ts", content: "x" });

		expect(emitter.sent).toEqual([{ path: inCwd("src/a.ts"), activity: "write" }]);
	});

	it("returns the wrapped tool's result verbatim", async () => {
		const emitter = collectingEmitter();
		const inner: AgentToolResult = { content: [{ type: "text", text: "payload" }], details: { n: 7 } };
		const tool = withWakatimeTracking(
			makeTool("read", async () => inner),
			emitter,
			CWD,
		);

		const result = await tool.execute("call-1", { path: "src/a.ts" });

		expect(result).toBe(inner);
		expect(result.details).toEqual({ n: 7 });
		expect(emitter.sent).toHaveLength(1);
	});

	it("emits nothing when the wrapped tool throws, and propagates the error", async () => {
		const emitter = collectingEmitter();
		const boom = new Error("tool blew up");
		const tool = withWakatimeTracking(
			makeTool("read", async () => {
				throw boom;
			}),
			emitter,
			CWD,
		);

		await expect(tool.execute("call-1", { path: "src/a.ts" })).rejects.toThrow("tool blew up");
		expect(emitter.sent).toEqual([]);
	});

	it("emits nothing when the tool reports a non-throwing failure", async () => {
		const emitter = collectingEmitter();
		const failure: AgentToolResult = { content: [{ type: "text", text: "no such file" }], isError: true };
		const tool = withWakatimeTracking(
			makeTool("read", async () => failure),
			emitter,
			CWD,
		);

		expect(await tool.execute("call-1", { path: "missing.ts" })).toBe(failure);
		expect(emitter.sent).toEqual([]);
	});

	it("survives an emitter that throws", async () => {
		const throwing: HeartbeatEmitter = {
			record() {
				throw new Error("emitter exploded");
			},
			async flush() {},
		};
		const tool = withWakatimeTracking(
			makeTool("read", async () => OK_RESULT),
			throwing,
			CWD,
		);

		expect(await tool.execute("call-1", { path: "src/a.ts" })).toBe(OK_RESULT);
	});

	it("leaves tools that touch no files untouched", async () => {
		const emitter = collectingEmitter();
		const original = makeTool("bash", async () => OK_RESULT);
		const execute = original.execute;

		const tool = withWakatimeTracking(original, emitter, CWD);

		expect(tool).toBe(original);
		expect(tool.execute).toBe(execute);
		await tool.execute("call-1", { command: "ls" });
		expect(emitter.sent).toEqual([]);
	});

	it("preserves every other property of the wrapped tool", async () => {
		const emitter = collectingEmitter();
		const original = makeTool("read", async () => OK_RESULT);
		const { approval, parameters } = original;

		const tool = withWakatimeTracking(original, emitter, CWD);

		expect(tool.name).toBe("read");
		expect(tool.label).toBe("Fake");
		expect(tool.description).toBe("fake tool");
		expect(tool.summary).toBe("fake summary");
		expect(tool.loadMode).toBe("essential");
		expect(tool.strict).toBe(true);
		expect(tool.approval).toBe(approval);
		expect(tool.parameters).toBe(parameters);
	});

	it("does not double-emit when wrapped twice", async () => {
		const emitter = collectingEmitter();
		const once = withWakatimeTracking(
			makeTool("read", async () => OK_RESULT),
			emitter,
			CWD,
		);
		const twice = withWakatimeTracking(once, emitter, CWD);

		await twice.execute("call-1", { path: "src/a.ts" });

		expect(emitter.sent).toEqual([{ path: inCwd("src/a.ts"), activity: "read" }]);
	});

	it("forwards every execute argument to the wrapped tool", async () => {
		const emitter = collectingEmitter();
		const seen: unknown[] = [];
		const controller = new AbortController();
		const onUpdate = () => {};
		const original = makeTool("read", async () => OK_RESULT);
		original.execute = (...args: unknown[]) => {
			seen.push(...args);
			return Promise.resolve(OK_RESULT);
		};

		const tool = withWakatimeTracking(original, emitter, CWD);
		await tool.execute("call-7", { path: "a.ts" }, controller.signal, onUpdate);

		expect(seen).toEqual(["call-7", { path: "a.ts" }, controller.signal, onUpdate, undefined]);
	});
});
