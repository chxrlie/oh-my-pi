/**
 * Local embeddings for the native palace.
 *
 * The harness already runs fastembed in a dedicated subprocess for mnemopi —
 * `onnxruntime-node`'s NAPI constructor and finalizer must never run inside the
 * agent's own address space (issue #3031) — so the palace borrows that worker
 * rather than standing up a second one. Sharing the client *and* the default
 * model id means both subsystems hit one warm model instead of paying two ONNX
 * loads and holding two copies of the weights.
 *
 * Nothing here throws. A palace whose embeddings are unavailable must degrade
 * to lexical-only search, never break the turn that queried it, so every
 * failure path resolves to `null` and leaves a debug breadcrumb.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { type MnemopiSubprocessEmbeddingModel, mnemopiEmbedClient } from "../mnemopi/embed-client";
import type { EmbedFn } from "./types";

/**
 * The fastembed model `loadMnemopiConfig` derives for the default (English)
 * embedding variant. Kept identical on purpose: two ids would mean two model
 * loads in the shared worker, and vectors stored under one id are invisible to
 * a search issued under the other.
 */
export const DEFAULT_MEMPALACE_EMBED_MODEL = "BAAI/bge-base-en-v1.5";

export interface LocalEmbedOptions {
	/** Defaults to {@link DEFAULT_MEMPALACE_EMBED_MODEL}. */
	model?: string;
	/** fastembed weight cache; `undefined` lets the worker pick its own. */
	cacheDir?: string;
}

/**
 * Build an {@link EmbedFn} backed by the shared embeddings subprocess.
 *
 * The `initialize()` promise is memoized — including a failed one. Retrying per
 * query would respawn a subprocess and re-attempt an ONNX load on every search
 * in a session that has already proven it has no embeddings stack, which is
 * exactly the stall the degradation path exists to avoid.
 */
export function createLocalEmbedFn(options: LocalEmbedOptions = {}): EmbedFn {
	const model = options.model?.trim() || DEFAULT_MEMPALACE_EMBED_MODEL;
	const cacheDir = options.cacheDir;
	let handle: Promise<MnemopiSubprocessEmbeddingModel | null> | undefined;

	return async (texts, signal) => {
		if (texts.length === 0) return [];
		if (signal?.aborted) return null;
		try {
			handle ??= mnemopiEmbedClient.initialize(model, cacheDir);
			const embedder = await handle;
			if (!embedder) {
				logger.debug("mempalace-native: embeddings unavailable", { model });
				return null;
			}
			if (signal?.aborted) return null;

			const vectors: number[][] = [];
			for await (const batch of embedder.embed(texts)) {
				if (signal?.aborted) return null;
				for (const vector of batch) vectors.push(unitNormalize(vector));
			}
			// A short or long batch means the worker and the caller disagree about
			// which text produced which vector; storing that would mislabel every
			// drawer in the batch, so the whole call is discarded instead.
			if (vectors.length !== texts.length) {
				logger.warn("mempalace-native: embedder returned a mismatched vector count", {
					model,
					expected: texts.length,
					received: vectors.length,
				});
				return null;
			}
			return vectors;
		} catch (error) {
			logger.debug("mempalace-native: embed failed", {
				model,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	};
}

/**
 * Scale a vector to length 1 so the vault's cosine scan is a plain dot product.
 * A zero-norm (or non-finite) vector passes through untouched: there is no
 * direction to preserve and dividing would poison every component with `NaN`.
 */
function unitNormalize(vector: number[]): number[] {
	let sumSquares = 0;
	for (const value of vector) sumSquares += value * value;
	if (!(sumSquares > 0) || !Number.isFinite(sumSquares)) return vector;
	const norm = Math.sqrt(sumSquares);
	// fastembed already emits unit vectors for most models; skip the copy.
	if (Math.abs(norm - 1) <= 1e-6) return vector;
	const normalized = new Array<number>(vector.length);
	for (let index = 0; index < vector.length; index++) normalized[index] = vector[index] / norm;
	return normalized;
}
