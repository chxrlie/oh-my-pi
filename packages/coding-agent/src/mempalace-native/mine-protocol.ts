/**
 * Wire types between the parent (`mine-client.ts`) and the mine subprocess
 * (`mine-worker.ts`).
 *
 * Mining is the process-intensive half of the native palace: a directory walk,
 * a read and a SHA-256 per candidate file, then chunking. Every one of those is
 * synchronous, so running them on the agent's thread would stall the turn loop
 * for the whole mine and make `AbortSignal` useless — the signal could only be
 * observed between files, long after the damage. The child owns all of it; the
 * parent keeps only the ledger diff and the vault writes.
 *
 * Backpressure is explicit rather than implied: the worker sends one `file`
 * message, then waits for the parent's `ack` before walking on. A slow vault
 * therefore throttles the walk instead of queueing an unbounded backlog of
 * chunked file bodies in the parent's heap.
 */

import type { MinedFilePayload, MinePlan, MineRunSummary, MineWorkerPlanRequest, MineWorkerRunRequest } from "./types";

export type MineWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "plan"; id: string; request: MineWorkerPlanRequest }
	| { type: "run"; id: string; request: MineWorkerRunRequest }
	/** Parent finished persisting the file it was last sent; keep walking. */
	| { type: "ack"; id: string }
	/** Stop the current run at the next file boundary and report what was done. */
	| { type: "cancel"; id: string };

export type MineWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "plan"; id: string; plan: MinePlan }
	| { type: "file"; id: string; file: MinedFilePayload }
	| { type: "done"; id: string; summary: MineRunSummary }
	| { type: "error"; id: string; error: string }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> };

export interface MineWorkerTransport {
	send(message: MineWorkerOutbound): void;
	onMessage(handler: (message: MineWorkerInbound) => void): () => void;
}

/**
 * Hidden subcommand on the main CLI that boots the mine worker in the spawned
 * subprocess. Kept in sync with the dispatch in `cli.ts`.
 */
export const MEMPALACE_MINE_WORKER_ARG = "__omp_worker_mempalace_mine";
