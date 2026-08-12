/**
 * Session-state attachment for the native MemPalace backend.
 *
 * Deliberately dependency-free: it imports nothing but types. `tools/index.ts`
 * and `session/agent-session.ts` both need the accessor, and they are on the
 * CLI startup path — importing it from `backend.ts` would drag the vault, the
 * searcher, the miner and the mine scheduler into every session's module
 * graph, including `memory.backend: off`. `backend.ts` stays behind the lazy
 * `await import()` in `resolveMemoryBackend`, like every sibling backend.
 */

import type { AgentSession } from "../session/agent-session";
import type { MempalaceNativeSession } from "./types";

const kMempalaceNativeSessionState = Symbol("mempalaceNative.sessionState");

interface AgentSessionWithMempalaceNativeState extends AgentSession {
	[kMempalaceNativeSessionState]?: MempalaceNativeSession;
}

export function getMempalaceNativeSessionState(session: AgentSession | undefined): MempalaceNativeSession | undefined {
	return session ? (session as AgentSessionWithMempalaceNativeState)[kMempalaceNativeSessionState] : undefined;
}

/** Attach (or, with `undefined`, detach) the state, returning what was previously there. */
export function setMempalaceNativeSessionState(
	session: AgentSession,
	state: MempalaceNativeSession | undefined,
): MempalaceNativeSession | undefined {
	const target = session as AgentSessionWithMempalaceNativeState;
	const previous = target[kMempalaceNativeSessionState];
	target[kMempalaceNativeSessionState] = state;
	return previous;
}
