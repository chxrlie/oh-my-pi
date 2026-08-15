import type { ToolSession } from "../../tools";
import {
	type ExecutorBackend,
	type ExecutorBackendExecOptions,
	type ExecutorBackendResult,
	resolveEvalUrlRoots,
} from "../backend";
import {
	namespaceSessionId as sharedNamespace,
	readInterpreterSetting as sharedReadInterpreterSetting,
	toExecutorBackendResult,
} from "../backend-helpers";
import { executeRust } from "./executor";
import { resolveRustRuntime } from "./runtime";

const RUST_SESSION_PREFIX = "rust:";

export function namespaceSessionId(sessionId: string): string {
	return sharedNamespace(sessionId, RUST_SESSION_PREFIX);
}

function readInterpreterSetting(session: ToolSession): string | undefined {
	return sharedReadInterpreterSetting(session, "rust.interpreter");
}

export default {
	id: "rust",
	label: "Rust",
	highlightLang: "rust",

	async isAvailable(session: ToolSession): Promise<boolean> {
		try {
			resolveRustRuntime(
				session.cwd,
				{},
				readInterpreterSetting(session),
			);
			return true;
		} catch {
			return false;
		}
	},
	async execute(
		code: string,
		opts: ExecutorBackendExecOptions,
	): Promise<ExecutorBackendResult> {
		// Build a filtered environment from the session shell config
		const sessionEnv: Record<string, string | undefined> = { ...process.env as Record<string, string | undefined> };
		const result = await executeRust(code, {
			cwd: opts.cwd,
			idleTimeoutMs: opts.idleTimeoutMs,
			signal: opts.signal,
			interpreter: readInterpreterSetting(opts.session),
			onChunk: opts.onChunk,
			localRoots: resolveEvalUrlRoots(opts.session),
			artifactsDir: opts.session.getArtifactsDir?.() ?? undefined,
			sessionEnv,
		});
		return toExecutorBackendResult(result);
	},
} satisfies ExecutorBackend;
