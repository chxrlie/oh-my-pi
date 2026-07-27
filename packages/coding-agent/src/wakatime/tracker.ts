/**
 * Automatic WakaTime activity tracking for file-touching tools.
 *
 * `createTools` wraps every tool whose name maps to an activity so a successful
 * execution emits one heartbeat per file the call touched. Emission is pure
 * telemetry: it runs after the wrapped tool resolved, never mutates the result,
 * and swallows its own failures so a broken emitter can never surface as a tool
 * error.
 */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolExecFn,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import {
	isInternalUrlPath,
	isReadableUrlPath,
	normalizePathLikeInput,
	parseSearchPath,
	resolveToCwd,
	splitPathAndSel,
	toPathList,
} from "../tools/path-utils";
import type { HeartbeatEmitter } from "./heartbeats";

/** Structural match for `Tool` in `../tools`, taken from the root type to keep this module cycle-free. */
type Tool = AgentTool<any, any, any>;

export type TrackedActivity = "read" | "write";

/**
 * Per-tool extraction rules.
 *
 * `scope` marks tools whose path argument names a *search scope* rather than an
 * exact file: those accept the documented semicolon-delimited list form
 * (`"src; tests"`) and may carry a glob tail, which is trimmed back to the
 * enclosing directory so the heartbeat entity is a path that exists. Exact-path
 * tools skip both, so a real filename containing `;` or `[` survives intact.
 */
interface ToolPathRule {
	activity: TrackedActivity;
	scope: boolean;
}

const TOOL_PATH_RULES: Record<string, ToolPathRule> = {
	read: { activity: "read", scope: false },
	glob: { activity: "read", scope: true },
	grep: { activity: "read", scope: true },
	ast_grep: { activity: "read", scope: true },
	write: { activity: "write", scope: false },
	edit: { activity: "write", scope: false },
	ast_edit: { activity: "write", scope: true },
};

/** Maps a tool name to the activity it represents, or null when the tool touches no files. */
export function classifyToolActivity(toolName: string): TrackedActivity | null {
	// `hasOwn` guard: tool names arrive from the model, so a bare index would let
	// `constructor`/`toString` resolve through the prototype chain.
	return Object.hasOwn(TOOL_PATH_RULES, toolName) ? TOOL_PATH_RULES[toolName].activity : null;
}

/**
 * Any `scheme://` target is a non-filesystem entity: the internal protocols
 * (`skill://`, `agent://`, `artifact://`, `memory://`, `xd://`, `vault://`,
 * `issue://`, `pr://`, `mcp://`, `ssh://`, `local://`, `history://`, …) plus
 * ordinary web URLs. Matching the scheme shape rather than a fixed list keeps
 * this correct as protocols are added.
 */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Hashline section header: `[path/to/file.ts#A1B2]`, tag optional. Mirrors `src/edit/streaming.ts`. */
const HASHLINE_HEADER_RE = /^\s*\[([^\]\r\n]+?)(?:#[0-9a-fA-F]{4})?\]\s*$/gm;
/** apply_patch envelope header: `*** Update File: path/to/file.ts`. */
const APPLY_PATCH_HEADER_RE = /^\s*\*{3}\s+(?:Add|Update|Delete)\s+File\s*:\s*(\S.*?)\s*$/gm;
/** `*** Add File:` / `*** Move to:` noise the model sometimes pastes inside a hashline header. */
const HASHLINE_HEADER_NOISE_RE = /^\s*\*{3}\s*(?:(?:Add|Update|Delete)\s+File|Move\s+to)\s*:\s*/i;

/** Normalize a `path`/`paths` argument that may be a string, a JSON-encoded array, or a real array. */
function pathArgCandidates(value: unknown): string[] {
	if (typeof value === "string") return toPathList(value);
	if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
	return [];
}

/** Pull `[path#TAG]` and `*** Update File:` headers out of an `edit` patch body. */
function patchBodyPaths(input: string): string[] {
	const found: string[] = [];
	for (const match of input.matchAll(HASHLINE_HEADER_RE)) {
		const candidate = match[1].replace(HASHLINE_HEADER_NOISE_RE, "").trim();
		if (candidate.length > 0) found.push(candidate);
	}
	for (const match of input.matchAll(APPLY_PATCH_HEADER_RE)) {
		const candidate = match[1].trim();
		if (candidate.length > 0) found.push(candidate);
	}
	return found;
}

/** Extracts absolute filesystem paths from a tool call's arguments. Returns [] when none apply. */
export function extractToolPaths(toolName: string, args: unknown, cwd: string): string[] {
	if (!Object.hasOwn(TOOL_PATH_RULES, toolName)) return [];
	if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
	const rule = TOOL_PATH_RULES[toolName];
	const record = args as Record<string, unknown>;

	// `path` and `paths` are read unconditionally: no tool declares both, so
	// accepting either absorbs a model that reaches for the wrong arity.
	const raw = [...pathArgCandidates(record.path), ...pathArgCandidates(record.paths)];
	if (toolName === "edit") {
		// hashline/apply_patch modes carry the targets inside the patch body;
		// replace/patch modes name them in `path`, already collected above.
		const input = record.input ?? record._input;
		if (typeof input === "string" && input.length > 0) raw.push(...patchBodyPaths(input));
	}

	const resolved: string[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		for (const part of rule.scope ? entry.split(";") : [entry]) {
			const candidate = normalizePathLikeInput(part);
			if (candidate.length === 0) continue;
			if (URL_SCHEME_RE.test(candidate) || isReadableUrlPath(candidate) || isInternalUrlPath(candidate)) {
				continue;
			}
			// Peel a trailing `:50-200` line selector — the splitter only fires on
			// the strict range grammar, so a literal `notes:1-2` filename survives.
			const peeled = splitPathAndSel(candidate).path;
			const base = rule.scope ? parseSearchPath(peeled).basePath : peeled;
			if (base.length === 0) continue;
			let absolute: string;
			try {
				absolute = resolveToCwd(base, cwd);
			} catch {
				continue;
			}
			if (seen.has(absolute)) continue;
			seen.add(absolute);
			resolved.push(absolute);
		}
	}
	return resolved;
}

/** Marks a tool whose `execute` already emits heartbeats, so re-wrapping is a no-op. */
const kWakatimeTracked = Symbol("Wakatime.Tracked");

/**
 * Wraps a tool so successful executions emit WakaTime heartbeats. Returns the
 * tool unchanged when tracking is off.
 *
 * Follows `wrapToolWithMetaNotice`: `execute` is redefined in place, so every
 * other property — including accessors and arrow-function members such as
 * `EditTool.approval` — is preserved exactly rather than re-derived by a copy.
 */
export function withWakatimeTracking<T extends Tool>(tool: T, emitter: HeartbeatEmitter, cwd: string): T {
	const activity = classifyToolActivity(tool.name);
	if (activity === null || kWakatimeTracked in tool) return tool;

	const toolName = tool.name;
	const inner = tool.execute;
	const trackedExecute: AgentToolExecFn = async function (
		this: Tool,
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const result = await inner.call(this, toolCallId, params, signal, onUpdate, context);
		// A throw above skips emission entirely: only work that landed is recorded.
		// A result flagged `isError` is a failed call too (a missing file, a
		// rejected patch), so it earns no heartbeat either.
		if (result?.isError !== true) {
			try {
				for (const filePath of extractToolPaths(toolName, params, cwd)) {
					emitter.record(filePath, activity);
				}
			} catch {
				// Telemetry is never allowed to fail a tool call.
			}
		}
		return result;
	};

	return Object.defineProperties(tool, {
		[kWakatimeTracked]: { value: true, enumerable: false, configurable: true },
		execute: { value: trackedExecute, enumerable: false, configurable: true, writable: true },
	});
}
