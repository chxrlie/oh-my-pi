/**
 * Settings resolution for the native MemPalace store.
 *
 * Every read here is defensive. The `mempalaceNative.*` keys are registered in
 * the settings schema separately from this module, and `Settings.get` throws on
 * a path it has never heard of (it indexes a schema-derived segment table), so
 * an unregistered — or simply misconfigured — key must degrade to the
 * documented default rather than take an agent turn down with it.
 *
 * Numbers follow one rule everywhere: a value that is not a finite number, or
 * is negative, is *ignored* in favour of the default. It is never coerced to
 * `0`, because a silent `0` for a budget or an interval reads as "disabled" and
 * would quietly change behaviour instead of falling back to it.
 */

import { isAbsolute, join, resolve } from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { DEFAULT_MEMPALACE_EMBED_MODEL } from "./embed";
import { wingNameFor } from "./vault";

export interface MempalaceNativeConfig {
	/** Absolute path to the sqlite palace file. */
	dbPath: string;
	/** Wing this session reads and writes by default, derived from {@link cwd}. */
	wing: string;
	/** Project directory the wing was derived from; also the default mine target. */
	cwd: string;
	/** Harness agent directory; the default palace location and session-log root. */
	agentDir: string;
	/** Whether to attach a local embedder, enabling hybrid search. */
	embeddings: boolean;
	/** Model id recorded alongside stored vectors. */
	embedModel: string;
	/** Default hit count for `search`, clamped to `1..50`. */
	searchLimit: number;
	/** Soft ceiling on the rendered wake-up section, clamped to `100..4000`. */
	wakeUpTokenBudget: number;

	// ── Smart Mining ────────────────────────────────────────────────────────
	/** Mine automatically at all. Off by default: mining is process-intensive. */
	autoIngest: boolean;
	/** Substantive user turns between cadence evaluations. */
	ingestIntervalMessages: number;
	/** Wall-clock ceiling for one mine slice. */
	mineBudgetMillis: number;
	/** Quiet period after a turn ends before an idle mine may start. */
	mineIdleDelayMillis: number;
	/** Floor between two automatic runs, regardless of trigger. */
	mineMinIntervalMillis: number;
	/** Refuse to auto-run when the stat-only pre-flight estimates more than this. */
	mineMaxAutoEstimatedMillis: number;
}

/** Documented fallbacks, exported so the tool and the tests can name them. */
export const MEMPALACE_NATIVE_DEFAULTS = {
	embeddings: true,
	searchLimit: 10,
	wakeUpTokenBudget: 900,
	autoIngest: false,
	ingestIntervalMessages: 15,
	mineBudgetMillis: 4_000,
	mineIdleDelayMillis: 2_000,
	mineMinIntervalMillis: 60_000,
	mineMaxAutoEstimatedMillis: 120_000,
} as const;

/**
 * Resolve the effective native-palace configuration.
 *
 * Never throws: an unreadable settings store, an unregistered key, or a garbage
 * value all resolve to the documented default.
 */
export function loadMempalaceNativeConfig(settings: Settings, agentDir: string, cwd: string): MempalaceNativeConfig {
	const d = MEMPALACE_NATIVE_DEFAULTS;
	const rawDbPath = readSetting(settings, "mempalaceNative.dbPath");
	const rawEmbeddings = readSetting(settings, "mempalaceNative.embeddings");
	const rawAutoIngest = readSetting(settings, "mempalaceNative.autoIngest");
	return {
		dbPath: resolveDbPath(typeof rawDbPath === "string" ? rawDbPath : undefined, agentDir, cwd),
		wing: resolveWing(cwd),
		cwd,
		agentDir,
		embeddings: typeof rawEmbeddings === "boolean" ? rawEmbeddings : d.embeddings,
		embedModel: DEFAULT_MEMPALACE_EMBED_MODEL,
		searchLimit: readNumber(settings, "mempalaceNative.searchLimit", d.searchLimit, 1, 50),
		wakeUpTokenBudget: readNumber(settings, "mempalaceNative.wakeUpTokenBudget", d.wakeUpTokenBudget, 100, 4_000),
		autoIngest: typeof rawAutoIngest === "boolean" ? rawAutoIngest : d.autoIngest,
		ingestIntervalMessages: readNumber(
			settings,
			"mempalaceNative.ingestIntervalMessages",
			d.ingestIntervalMessages,
			1,
			Number.MAX_SAFE_INTEGER,
		),
		mineBudgetMillis: readNumber(settings, "mempalaceNative.mineBudgetMillis", d.mineBudgetMillis, 250, 60_000),
		mineIdleDelayMillis: readNumber(
			settings,
			"mempalaceNative.mineIdleDelayMillis",
			d.mineIdleDelayMillis,
			0,
			60_000,
		),
		mineMinIntervalMillis: readNumber(
			settings,
			"mempalaceNative.mineMinIntervalMillis",
			d.mineMinIntervalMillis,
			0,
			3_600_000,
		),
		mineMaxAutoEstimatedMillis: readNumber(
			settings,
			"mempalaceNative.mineMaxAutoEstimatedMillis",
			d.mineMaxAutoEstimatedMillis,
			1_000,
			3_600_000,
		),
	};
}

function resolveDbPath(configured: string | undefined, agentDir: string, cwd: string): string {
	const trimmed = configured?.trim();
	if (!trimmed) return join(agentDir, "mempalace-native", "palace.db");
	// `:memory:` is a sqlite sentinel, not a path — resolving it would create a
	// literal file called ":memory:" next to the project.
	if (trimmed === ":memory:" || isAbsolute(trimmed)) return trimmed;
	return resolve(cwd, trimmed);
}

/** `wingNameFor` owns the normalization; this only keeps a hostile `cwd` from throwing. */
function resolveWing(cwd: string): string {
	try {
		return wingNameFor(cwd) || "workspace";
	} catch (error) {
		logger.debug("MemPalace native: wing derivation failed; using `workspace`.", { cwd, error: String(error) });
		return "workspace";
	}
}

/** The widened shape of `Settings.get` used by {@link readSetting}. */
interface UncheckedSettingReader {
	get(path: string): unknown;
}

function readSetting(settings: Settings, key: string): unknown {
	// `Settings.get` is typed against the registered schema and indexes a
	// schema-derived segment table, so an unregistered path is both a compile
	// error and a runtime throw. The `mempalaceNative.*` keys land separately
	// from this module: widen the accessor, and read a throw as "unset".
	const reader = settings as unknown as UncheckedSettingReader;
	try {
		return reader.get(key);
	} catch {
		return undefined;
	}
}

/**
 * Read a numeric knob. Non-numeric, non-finite and negative values fall back to
 * `fallback`; anything else is rounded and clamped into `[min, max]`.
 */
function readNumber(settings: Settings, key: string, fallback: number, min: number, max: number): number {
	const value = readSetting(settings, key);
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}
