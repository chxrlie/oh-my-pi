import { logger } from "@oh-my-pi/pi-utils";
import {
	createUnavailableWorker,
	createWorkerHandle,
	createWorkerSubprocess,
	logWorkerMessage,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
	spawnWorkerOrUnavailable,
	type WorkerHandle,
	workerEnvFromParent,
} from "../subprocess/worker-client";
import { safeSend } from "../utils/ipc";
import { MEMPALACE_MINE_WORKER_ARG, type MineWorkerInbound, type MineWorkerOutbound } from "./mine-protocol";
import type {
	MinedFilePayload,
	MinePlan,
	MineRunSummary,
	MineWorkerHandle,
	MineWorkerPlanRequest,
	MineWorkerRunRequest,
} from "./types";

/**
 * Parent side of the mine subprocess. The child owns the walk, the reads, the
 * hashing and the chunking — all synchronous work that would otherwise pin the
 * agent's event loop for the whole duration of a mine — while this module owns
 * request correlation, the `file` → `ack` backpressure handshake, and the
 * degradation rules.
 *
 * Nothing here throws at the caller. A worker that never spawned, one that dies
 * mid-walk, and one that answers with an error all resolve the same way a
 * fruitless run does: `plan` to `null`, `run` to a summary with
 * `completed: false`. Mining is opportunistic background work; it must never be
 * able to fault an agent turn.
 */

/** Raw parent-side view of the child, before request correlation is layered on. */
export type MempalaceMineWorkerHandle = WorkerHandle<MineWorkerInbound, MineWorkerOutbound>;

interface PendingPlan {
	kind: "plan";
	settle: (plan: MinePlan | null) => void;
}

interface PendingRun {
	kind: "run";
	onFile: (file: MinedFilePayload) => Promise<void> | void;
	/**
	 * Serializes `onFile` invocations. The child already gates itself on `ack`,
	 * so this queue is normally one deep; it exists so a worker that streams
	 * ahead of the protocol still gets its files persisted in walk order.
	 */
	queue: Promise<void>;
	/** Files handed to the parent, so a mid-run death still reports real progress. */
	filesSeen: number;
	/** Set once the parent asked the child to stop; suppresses further work and acks. */
	cancelled: boolean;
	settle: (summary: MineRunSummary) => void;
}

type PendingRequest = PendingPlan | PendingRun;

/** The summary a run degrades to when the child never reported its own counters. */
function degradedSummary(filesScanned: number, warning: string): MineRunSummary {
	return { filesScanned, filesSkipped: 0, filesUnchanged: 0, completed: false, warnings: [warning] };
}

/**
 * Spawn the mine worker as a subprocess. Exported for tests and the smoke
 * probe; production callers go through {@link createMineWorkerHandle}. The
 * child inherits the parent env verbatim so it resolves the same ignore files,
 * `OMP_*` knobs and temp roots the parent would.
 */
export function createMempalaceMineSubprocess(): SpawnedSubprocess<MineWorkerOutbound> {
	return createWorkerSubprocess<MineWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(MEMPALACE_MINE_WORKER_ARG),
		env: workerEnvFromParent(),
		exitLabel: "mempalace mine subprocess",
	});
}

function wrapSubprocess(spawned: SpawnedSubprocess<MineWorkerOutbound>): MempalaceMineWorkerHandle {
	const { proc } = spawned;
	return createWorkerHandle<MineWorkerInbound, MineWorkerOutbound>(spawned, message =>
		safeSend(proc, message, "mempalace-mine"),
	);
}

function spawnMempalaceMineWorker(): MempalaceMineWorkerHandle {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createMempalaceMineSubprocess()),
		createUnavailableWorker<MineWorkerInbound, MineWorkerOutbound>,
		"mempalace mine worker spawn failed; native mining disabled",
	);
}

class MineWorkerClient implements MineWorkerHandle {
	#worker: MempalaceMineWorkerHandle | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#nextRequestId = 0;
	#disposed = false;
	#spawnWorker: () => MempalaceMineWorkerHandle;

	constructor(spawnWorker: () => MempalaceMineWorkerHandle) {
		this.#spawnWorker = spawnWorker;
	}

	async plan(request: MineWorkerPlanRequest): Promise<MinePlan | null> {
		const worker = this.#ensureWorker();
		if (!worker) return null;
		const id = String(++this.#nextRequestId);
		const { promise, resolve } = Promise.withResolvers<MinePlan | null>();
		this.#pending.set(id, { kind: "plan", settle: resolve });
		try {
			worker.send({ type: "plan", id, request });
			return await promise;
		} finally {
			this.#pending.delete(id);
		}
	}

	async run(
		request: MineWorkerRunRequest,
		onFile: (file: MinedFilePayload) => Promise<void> | void,
	): Promise<MineRunSummary> {
		const worker = this.#ensureWorker();
		if (!worker) return degradedSummary(0, "mempalace mine worker unavailable");
		const id = String(++this.#nextRequestId);
		const { promise, resolve } = Promise.withResolvers<MineRunSummary>();
		this.#pending.set(id, {
			kind: "run",
			onFile,
			queue: Promise.resolve(),
			filesSeen: 0,
			cancelled: false,
			settle: resolve,
		});
		try {
			worker.send({ type: "run", id, request });
			return await promise;
		} finally {
			this.#pending.delete(id);
		}
	}

	/**
	 * Hard-kill the child and fail every in-flight request. Terminal: a disposed
	 * client never respawns, so a stray late call degrades instead of quietly
	 * resurrecting a subprocess the owner believed it had released.
	 */
	dispose(): void {
		this.#disposed = true;
		this.#settleAll("mempalace mine worker disposed");
		this.#teardownWorker();
	}

	/** `null` once disposed, or when the handle could not be constructed at all. */
	#ensureWorker(): MempalaceMineWorkerHandle | null {
		if (this.#disposed) return null;
		if (this.#worker) return this.#worker;
		let worker: MempalaceMineWorkerHandle;
		try {
			worker = this.#spawnWorker();
		} catch (error) {
			logger.warn("mempalace-mine: worker spawn failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
		this.#worker = worker;
		this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		return worker;
	}

	#handleMessage(message: MineWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "pong") return;

		const pending = this.#pending.get(message.id);
		if (!pending) return;

		if (message.type === "file") {
			// A `file` for a plan request is a worker bug; dropping it (rather
			// than acking) stalls that walk instead of corrupting the palace.
			if (pending.kind === "run") this.#deliverFile(message.id, pending, message.file);
			return;
		}
		if (message.type === "plan") {
			this.#pending.delete(message.id);
			if (pending.kind === "plan") pending.settle(message.plan);
			else pending.settle(degradedSummary(pending.filesSeen, "mempalace mine worker answered a run with a plan"));
			return;
		}
		if (message.type === "done") {
			this.#pending.delete(message.id);
			if (pending.kind !== "run") {
				pending.settle(null);
				return;
			}
			// Settle only once the last `onFile` has landed: a worker that ends
			// on its budget may emit `done` without waiting for the final ack,
			// and the parent's drawer writes for that file must still count.
			const summary = pending.cancelled ? { ...message.summary, completed: false } : message.summary;
			void pending.queue.then(() => pending.settle(summary));
			return;
		}

		this.#pending.delete(message.id);
		logger.debug("mempalace-mine: worker returned an error", { error: message.error });
		if (pending.kind === "plan") pending.settle(null);
		else pending.settle(degradedSummary(pending.filesSeen, message.error));
	}

	/**
	 * Run the parent's persist callback for one streamed file, then ack. The ack
	 * is deliberately *after* the await: that is the whole backpressure
	 * mechanism, so a slow vault throttles the child's walk rather than letting
	 * chunked file bodies pile up in the parent's heap.
	 */
	#deliverFile(id: string, pending: PendingRun, file: MinedFilePayload): void {
		pending.filesSeen += 1;
		pending.queue = pending.queue.then(async () => {
			if (!pending.cancelled) {
				try {
					await pending.onFile(file);
				} catch (error) {
					// The parent refused the file — an abort, or a vault that
					// is no longer writable. Either way the walk is pointless.
					this.#cancelRun(id, pending, error);
				}
			}
			// Acked even after a cancel: the child parks on this ack, and the
			// run settles only on its `done`, so skipping it would wedge both.
			this.#worker?.send({ type: "ack", id });
		});
	}

	#cancelRun(id: string, pending: PendingRun, error: unknown): void {
		if (pending.cancelled) return;
		pending.cancelled = true;
		logger.debug("mempalace-mine: parent cancelled the run", {
			error: error instanceof Error ? error.message : String(error),
		});
		// Stops the walk at the next file boundary; the caller's `#deliverFile`
		// still acks, so the child never parks. The run settles on the child's
		// own `done`, which keeps its counters honest and proves it went idle.
		this.#worker?.send({ type: "cancel", id });
	}

	#handleWorkerError(error: Error): void {
		logger.warn("mempalace-mine: worker error", { error: error.message });
		this.#settleAll(error.message);
		// The child is gone. Drop the handle (without disposing the client) so
		// the next mine spawns a fresh one instead of sending into a dead pipe.
		this.#teardownWorker();
	}

	#settleAll(reason: string): void {
		for (const pending of this.#pending.values()) {
			if (pending.kind === "plan") pending.settle(null);
			else {
				pending.cancelled = true;
				pending.settle(degradedSummary(pending.filesSeen, reason));
			}
		}
		this.#pending.clear();
	}

	#teardownWorker(): void {
		const worker = this.#worker;
		this.#worker = null;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = null;
		this.#unsubscribeError?.();
		this.#unsubscribeError = null;
		try {
			void worker?.terminate();
		} catch {
			// Already gone.
		}
	}
}

/**
 * Build a correlated handle over the mine subprocess. The child is spawned
 * lazily on the first `plan` or `run`, so importing this module — or
 * constructing a {@link MineWorkerHandle} the scheduler may never use — costs
 * nothing. `spawnWorker` is injectable so the handshake can be exercised
 * in-process; production passes nothing.
 */
export function createMineWorkerHandle(
	spawnWorker: () => MempalaceMineWorkerHandle = spawnMempalaceMineWorker,
): MineWorkerHandle {
	return new MineWorkerClient(spawnWorker);
}

export async function smokeTestMempalaceMineWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(wrapSubprocess(createMempalaceMineSubprocess()), "mempalace mine worker", timeoutMs);
}
