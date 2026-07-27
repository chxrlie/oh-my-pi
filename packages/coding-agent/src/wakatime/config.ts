/**
 * WakaTime environment discovery.
 *
 * Everything the rest of the integration needs — where `wakatime-cli` lives, which API key to
 * authenticate with, and which API host to talk to — is resolved here, once, from the same
 * sources the official editor plugins use. Resolution is completely passive: nothing is written,
 * nothing is installed, and no network call is made.
 */
import * as os from "node:os";
import * as path from "node:path";
import { $which, logger } from "@oh-my-pi/pi-utils";

/** WakaTime's public API when `~/.wakatime.cfg` does not override `api_url`. */
const DEFAULT_API_URL = "https://api.wakatime.com/api/v1";

/** Candidate binary names, in the order the official plugins probe for them. */
const CLI_BINARY_NAMES = ["wakatime-cli", "wakatime"] as const;

/**
 * A subprocess runner shaped like `execCommand` from `../exec/exec`.
 *
 * Declared here so both the heartbeat emitter and the stats reader can accept the same injected
 * seam in tests without either module depending on the other.
 */
export type ExecFn = (
	command: string,
	args: string[],
	cwd: string,
	options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

/**
 * Resolved WakaTime environment.
 *
 * Both `cliPath` and `apiKey` are independently optional: a machine can have the CLI installed
 * without a key (heartbeats queue offline, stats are unavailable) or a key without the CLI
 * (stats work, heartbeats are dropped).
 */
export interface WakatimeConfig {
	/** Resolved wakatime-cli binary path, or null when not installed. */
	cliPath: string | null;
	/** API key from settings override, WAKATIME_API_KEY, or ~/.wakatime.cfg [settings] api_key. */
	apiKey: string | null;
	/** API base, default "https://api.wakatime.com/api/v1" (honours api_url in ~/.wakatime.cfg). */
	apiUrl: string;
}

/** Expand a leading `~` so user-supplied CLI overrides behave like shell paths. */
function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * Resolve one binary candidate.
 *
 * Path-like candidates (`./bin/wakatime-cli`, `/usr/bin/wakatime-cli`, `~/.wakatime/wakatime-cli`)
 * must exist on disk; bare names go through PATH. Returns null so the caller can fall through to
 * the next candidate rather than hard-failing on a stale override.
 */
async function resolveBinary(candidate: string | undefined): Promise<string | null> {
	const trimmed = candidate?.trim();
	if (!trimmed) return null;
	const expanded = expandHome(trimmed);
	if (expanded.includes(path.sep) || path.isAbsolute(expanded)) {
		const absolute = path.resolve(expanded);
		return (await Bun.file(absolute).exists()) ? absolute : null;
	}
	return $which(expanded);
}

/** Locate `wakatime-cli`: explicit override, then `$WAKATIME_CLI`, then PATH. */
async function resolveCliPath(override: string | undefined): Promise<string | null> {
	const fromOverride = await resolveBinary(override);
	if (fromOverride) return fromOverride;
	const fromEnv = await resolveBinary(Bun.env.WAKATIME_CLI);
	if (fromEnv) return fromEnv;
	for (const name of CLI_BINARY_NAMES) {
		const found = $which(name);
		if (found) return found;
	}
	return null;
}

/** `$WAKATIME_HOME/.wakatime.cfg` when set (matching wakatime-cli), else `~/.wakatime.cfg`. */
function cfgPath(): string {
	const home = Bun.env.WAKATIME_HOME?.trim();
	return path.join(home && home.length > 0 ? expandHome(home) : os.homedir(), ".wakatime.cfg");
}

/**
 * Minimal INI reader for a single section.
 *
 * `~/.wakatime.cfg` is a Python `configparser` file, so: full-line `#`/`;` comments only (inline
 * comments are literal value text), section names are case-insensitive, and only the first `=`
 * separates key from value — API keys, URLs, and `[projectmap]` regexes may all contain further
 * `=` characters.
 *
 * Keys come back verbatim. configparser folds option names to lower case and `readCfgSettings`
 * reproduces that for `[settings]`, but `[projectmap]` keys are regexes where folding would
 * silently rewrite `\D` into `\d`.
 */
function parseSection(text: string, section: string): Map<string, string> {
	const wanted = section.toLowerCase();
	const entries = new Map<string, string>();
	let inSection = false;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[")) {
			const close = line.indexOf("]");
			inSection = close > 1 && line.slice(1, close).trim().toLowerCase() === wanted;
			continue;
		}
		if (!inSection) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		if (key.length > 0) entries.set(key, line.slice(eq + 1).trim());
	}
	return entries;
}

/**
 * Normalise a configured `api_url` to a bare API base.
 *
 * Users (and older plugins) routinely point `api_url` straight at the heartbeats endpoint;
 * wakatime-cli tolerates that, so we do too.
 */
function normalizeApiUrl(raw: string | undefined): string {
	let url = raw?.trim();
	if (!url) return DEFAULT_API_URL;
	url = url.replace(/\/+$/, "");
	url = url.replace(/\/heartbeats(\.bulk)?$/i, "");
	url = url.replace(/\/+$/, "");
	return url.length > 0 ? url : DEFAULT_API_URL;
}

/**
 * Read one section of `~/.wakatime.cfg`. A missing or unreadable file is not an error — plenty of
 * setups configure WakaTime purely through the environment, and no section is ever mandatory.
 */
export async function readWakatimeCfgSection(section: string): Promise<Map<string, string>> {
	try {
		const file = Bun.file(cfgPath());
		if (!(await file.exists())) return new Map();
		return parseSection(await file.text(), section);
	} catch (err) {
		logger.debug("wakatime: could not read ~/.wakatime.cfg", { err });
		return new Map();
	}
}

/** `[settings]` with configparser's lower-cased option names, which every lookup below assumes. */
async function readCfgSettings(): Promise<Map<string, string>> {
	const folded = new Map<string, string>();
	for (const [key, value] of await readWakatimeCfgSection("settings")) folded.set(key.toLowerCase(), value);
	return folded;
}

/**
 * Resolve the WakaTime environment from settings, environment variables, and `~/.wakatime.cfg`.
 *
 * Never throws. Missing cli/key yield nulls.
 *
 * @param overrides - `cliPath` wins over `$WAKATIME_CLI` and PATH lookup when it points at a real file.
 */
export async function resolveWakatimeConfig(overrides?: { cliPath?: string }): Promise<WakatimeConfig> {
	try {
		const [cliPath, settings] = await Promise.all([resolveCliPath(overrides?.cliPath), readCfgSettings()]);
		const envKey = Bun.env.WAKATIME_API_KEY?.trim();
		const cfgKey = settings.get("api_key")?.trim();
		return {
			cliPath,
			apiKey: (envKey || cfgKey) ?? null,
			apiUrl: normalizeApiUrl(settings.get("api_url")),
		};
	} catch (err) {
		// Discovery is best-effort: a broken environment disables the integration, never the agent.
		logger.debug("wakatime: config resolution failed", { err });
		return { cliPath: null, apiKey: null, apiUrl: DEFAULT_API_URL };
	}
}
