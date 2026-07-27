/**
 * Coding-activity heartbeats.
 *
 * Every file the agent reads or edits becomes a WakaTime heartbeat, so agent-driven work shows up
 * on the user's dashboard alongside hand-written code. The emitter is deliberately unobservable
 * from the caller's side: {@link HeartbeatEmitter.record} is synchronous, returns nothing, and
 * cannot throw or reject. A missing CLI, a dead network, or a hung subprocess degrades to silence
 * rather than failing the tool call that triggered it.
 */
import { execCommand } from "../exec/exec";
import type { ExecFn, WakatimeConfig } from "./config";

/** WakaTime's own default category for agent-authored work. */
const DEFAULT_CATEGORY = "ai coding";

/** Reads repeat constantly; one heartbeat per file per two minutes is plenty of resolution. */
const DEFAULT_THROTTLE_MS = 120_000;

/** Hard cap on a single `wakatime-cli` invocation. Offline queueing makes a slow send pointless. */
const SEND_TIMEOUT_MS = 30_000;

/** Throttle-map size that triggers a prune. Large enough that normal sessions never pay for it. */
const MAX_TRACKED_PATHS = 512;

/** How the agent touched a file. `write` covers edits, creates, and overwrites. */
export type WakatimeActivity = "read" | "write";

/** Fire-and-forget sink for coding-activity heartbeats. */
export interface HeartbeatEmitter {
	/** Synchronous, fire-and-forget, never throws. Throttles reads; writes always send. */
	record(absolutePath: string, activity: WakatimeActivity): void;
	/** Resolves once in-flight sends settle. For tests and shutdown. */
	flush(): Promise<void>;
}

/** Construction options for {@link createHeartbeatEmitter}. */
export interface HeartbeatEmitterOptions {
	/** Resolved WakaTime environment. A null `cliPath` yields an inert emitter. */
	config: WakatimeConfig;
	/** Working directory for the `wakatime-cli` subprocess; also seeds project detection. */
	cwd: string;
	/** WakaTime category, default "ai coding". */
	category?: string;
	/** Value for wakatime-cli --plugin. */
	pluginId: string;
	/** Per-path throttle for read heartbeats, default 120000. */
	throttleMs?: number;
	/** Injected for tests; defaults to execCommand from "../exec/exec". */
	exec?: ExecFn;
}

/** Emitter used when WakaTime is unavailable — same shape, zero cost, no branches at the callsite. */
const INERT_EMITTER: HeartbeatEmitter = {
	record: () => {},
	flush: async () => {},
};

/**
 * Create a heartbeat emitter bound to one resolved WakaTime environment and working directory.
 *
 * Returns an inert emitter when `config.cliPath` is null, so callers never have to test for
 * availability. Heartbeats intentionally omit `--project`: the user's `~/.wakatime.cfg`
 * `[projectmap]` entries and `.wakatime-project` files already resolve project names, and an
 * explicit flag would override them.
 */
export function createHeartbeatEmitter(opts: HeartbeatEmitterOptions): HeartbeatEmitter {
	const cliPath = opts.config.cliPath;
	if (!cliPath) return INERT_EMITTER;

	const { cwd, pluginId } = opts;
	const category = opts.category ?? DEFAULT_CATEGORY;
	const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
	const exec = opts.exec ?? execCommand;

	/** Last send per absolute path. Dynamic keys, pruned at runtime — a Map, not a record. */
	const lastSentAt = new Map<string, number>();
	const inFlight = new Set<Promise<void>>();

	/**
	 * Keep the throttle map bounded across long sessions: first drop entries too old to still be
	 * throttling anything, then, if a wide refactor touched more live paths than the cap, evict
	 * oldest-first. Only runs once the map is already over the cap.
	 */
	const prune = (now: number): void => {
		if (lastSentAt.size <= MAX_TRACKED_PATHS) return;
		const cutoff = now - throttleMs * 10;
		for (const [key, at] of lastSentAt) {
			if (at < cutoff) lastSentAt.delete(key);
		}
		if (lastSentAt.size <= MAX_TRACKED_PATHS) return;
		const byAge = [...lastSentAt].sort((a, b) => a[1] - b[1]);
		for (let i = 0; i < byAge.length - MAX_TRACKED_PATHS; i++) {
			lastSentAt.delete(byAge[i][0]);
		}
	};

	return {
		record(absolutePath: string, activity: WakatimeActivity): void {
			try {
				if (absolutePath.length === 0) return;
				const now = Date.now();
				const isWrite = activity === "write";
				if (!isWrite) {
					const last = lastSentAt.get(absolutePath);
					if (last !== undefined && now - last < throttleMs) return;
				}
				lastSentAt.set(absolutePath, now);
				prune(now);

				const args = ["--entity", absolutePath, "--plugin", pluginId, "--category", category];
				if (isWrite) args.push("--write");

				// `.finally` runs at least one microtask after this statement, so the handle is
				// always in the set before the removal fires.
				const send: Promise<void> = exec(cliPath, args, cwd, { timeout: SEND_TIMEOUT_MS })
					.then(
						() => {},
						() => {},
					)
					.finally(() => {
						inFlight.delete(send);
					});
				inFlight.add(send);
			} catch {
				// Best-effort by contract: a heartbeat must never surface into the agent loop.
			}
		},

		async flush(): Promise<void> {
			// Drain in waves: a settling send can never enqueue another, but a concurrent
			// `record` during shutdown can, and callers expect those to be awaited too.
			while (inFlight.size > 0) {
				await Promise.all([...inFlight]);
			}
		},
	};
}
