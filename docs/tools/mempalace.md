# mempalace

> Read and curate the native MemPalace memory store — a local palace of wings, rooms, and drawers with hybrid search, a per-wing diary, and Smart Mining that ingests project trees incrementally in the background. Pure TypeScript, no Python.

## Source
- Entry: `packages/coding-agent/src/tools/mempalace.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/mempalace.md`
- Session surface the tool programs against: the `MempalaceNativeSession` interface at the tail of `packages/coding-agent/src/mempalace-native/types.ts`
- Symbol-keyed state accessors: `packages/coding-agent/src/mempalace-native/state.ts` (deliberately dependency-free, so `tools/index.ts` and `session/agent-session.ts` can reference the state without pulling the vault, searcher, miner, and scheduler into the CLI startup graph)
- Tool-session hook: `getMempalaceNativeSessionState` on `ToolSession` in `packages/coding-agent/src/tools/index.ts`, populated in `packages/coding-agent/src/session/agent-session.ts` and `packages/coding-agent/src/sdk.ts`
- Backend adapter (lazy-loaded behind `resolveMemoryBackend`): `packages/coding-agent/src/mempalace-native/backend.ts`
- Collaborators:
  - `packages/coding-agent/src/mempalace-native/vault.ts` — SQLite schema, drawer CRUD, content-hash dedup, FTS5 matching, vector blobs, and the mining ledger.
  - `packages/coding-agent/src/mempalace-native/search.ts` — embedding orchestration, lexical/vector fusion, snippets, wake-up context.
  - `packages/coding-agent/src/mempalace-native/miner.ts` — the walk, chunking, and prune, driven through a subprocess.
  - `packages/coding-agent/src/mempalace-native/scheduler.ts` — Smart Mining: whether, and when, to spend the cycles.
  - `packages/coding-agent/src/mempalace-native/mine-worker.ts` and `mine-client.ts` — the mine subprocess and its parent-side handle.

## Vocabulary
| Term | Meaning |
|---|---|
| Wing | A top-level partition, one per project, derived from the project directory name. |
| Room | A named grouping of drawers inside a wing — a topic, or a source directory when the drawers were mined. |
| Drawer | One stored memory: title, content, tags, provenance, and a content hash. |
| Diary | Dated free-text entries filed per wing, outside the room/drawer hierarchy. |

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `action` | `"search" \| "save" \| "get" \| "list" \| "diary" \| "mine" \| "sync" \| "status"` | Yes | Which operation to run. |
| `query` | `string` | For `search` | Natural-language or keyword search text. |
| `content` | `string` | For `save` | Drawer body. For `diary`, its presence is what selects a write over a read. |
| `id` | `string` | For `get` | Drawer id, as returned by `search` and `list`. |
| `wing` | `string` | No | Project partition. Defaults to the session's own wing. For `list`, its presence selects what gets listed. |
| `room` | `string` | No | Room within the wing. Defaults to `notes` on `save`. |
| `title` | `string` | No | Drawer title for `save`. Derived from the first line of the content, clamped to 72 characters, when omitted. |
| `dir` | `string` | For `mine` | Directory to walk. Also narrows `sync` to one tree. |
| `limit` | `number` | No | Result cap for `search`, `list`, and `diary` reads. Clamped by the backend. |
| `tags` | `string[]` | No | Free-form labels applied by `save` and `diary` writes. |
| `plan` | `boolean` | No | `mine` only. `true` runs the stat-only pre-flight and files nothing. |
| `force` | `boolean` | No | `mine` only. Re-reads files the ledger proves unchanged. |

Blank and whitespace-only strings are treated as absent, so `wing: "  "` falls back to the session wing rather than creating an empty wing.

## Outputs
Every action returns a single plain-text result.

- `search` — `Found <n> drawers for "<query>" (<mode>)` followed by numbered `wing/room · title` entries, each carrying `id: <id>`, a score, how it matched (`lexical`, `vector`, or `both`), and a whitespace-collapsed snippet. Zero hits renders `No drawers matched "<query>".` plus the scope searched and a suggestion, flagged contextually useless rather than returned as an empty body. A degraded mode — semantic search unavailable, say — appends the backend's own note.
- `save` — `Filed drawer <id> into <wing>/<room>.`, or `Drawer already filed as <id> in <wing>/<room> — identical content, nothing changed.` when that content hash already existed in the wing, or a `refreshed its title, room, and tags` line when the duplicate's mutable fields were updated in place. The wing and room are read back from the stored drawer, so the report reflects what the vault did rather than what was requested. A write that did not persist reports `MemPalace could not file the drawer into <wing>/<room>. Nothing was stored.` — see the sentinel note under Errors.
- `get` — a header block (`wing/room · title`, id, origin, writer, tags, source, path, timestamps) followed by the full drawer content.
- `list` — wings as `- <wing> — <n> rooms, <n> drawers`; rooms as `- <wing>/<room> — <n> drawers`; drawers as numbered title lines each carrying id and creation date.
- `diary` — a write confirms the entry id, wing, and timestamp, or reports `MemPalace could not write the diary entry to wing <wing>. Nothing was stored.` when it did not persist; a read renders dated entries with their tags and bodies.
- `mine` with `plan: true` — `Mine plan for <dir> (<mode> mode) — dry run, nothing was read or filed.` followed by an aligned block of `candidate files`, `changed`, `unchanged`, `changed bytes`, and `estimated cost`; a lower-bound warning when the walk was truncated; and a closing line that either says there is nothing to do or tells you to re-run without `plan`.
- `mine` without `plan` — elapsed time, then files scanned, skipped, and proved unchanged, drawers created and updated, then one of three completion lines. `Run completed.` is the finished case. A `completed: false` run is reported two different ways, because that flag is overloaded: with no warnings it is a clean stop on the budget, the file cap, or an abort, and reads as the normal sliced path that the scheduler resumes next slice; with warnings it reads as a run that did not finish and reported problems, which are then listed beneath.
- `sync` — `Sync complete: checked <n> sources, pruned <n> drawers.`
- `status` — a `Palace` block (wings, rooms, drawers, diary entries, vectors, database size, last write), an embeddings line, and a `Smart Mining` block.

## Flow
1. `MempalaceTool.createIf(session)` returns `null` unless `memory.backend` is exactly `mempalace-native`, so the tool is absent from the schema under every other backend — including the separate Python-backed `mempalace` backend.
2. `execute(...)` wraps the whole operation in `untilAborted(signal, ...)`, so a cancelled tool call stops waiting immediately, and the same signal is forwarded into search, mine, and sync.
3. It resolves state through the `getMempalaceNativeSessionState()` hook on the tool session, mirroring how `memory-recall.ts` reaches Mnemopi state. The backend installs state on the live `AgentSession` via the symbol accessors in `state.ts`; `agent-session.ts` and `sdk.ts` bridge it onto the tool-session facade that tools actually receive. Absent state throws.
4. The required field for the action is validated before any work begins, so a malformed call costs nothing and the error names both the field and the action.
5. The action is dispatched against the session surface, which owns defaulting and clamping and absorbs its own dependency failures — returning an empty hit list, a zeroed result, or `undefined` for a scheduler a subagent never had. The tool renders those states as plain prose. Because degradation already arrives as data, an exception here means a genuine fault: it is logged with its action and re-raised (normalised to an `Error`) rather than disguised as a successful result.

## Smart Mining
Mining is the process-intensive half of the palace: a directory walk, then a read, a SHA-256, and chunking for every candidate file. Four mechanisms keep that cost off the critical path.

**The subprocess.** The walk, the reads, the hashing, and the chunking all run in a child process. Every one of those steps is synchronous, so running them inline would stall the agent's event loop for the whole mine and make cancellation meaningless — the signal could only be observed between files, long after the damage. The parent keeps only the ledger diff and the vault writes. The child streams one file at a time and waits for the parent's acknowledgement before walking on, so a slow vault throttles the walk instead of piling chunked file bodies into the parent's heap.

**The ledger.** Every mined file is recorded with its size, mtime, content hash, and the number of drawers it produced. On the next pass, a size and mtime match proves the file unchanged and it is skipped without ever being opened. That is what turns a re-mine of a large tree from minutes of hashing into a stat walk. `force: true` discards the protection and pays the full cost again; it exists for the case where a file changed without its size or mtime moving.

**The pre-flight plan.** `plan: true` runs a stat-only walk that answers "is a mine worth running?" without reading a byte. It reports how many candidates exist, how many actually changed, and a rough `estimatedMillis`. The scheduler runs this before every automatic mine and skips entirely when nothing changed; agents should run it before every manual one.

**The scheduler.** Automatic mining is off unless enabled. When it is on, nothing mines on a whim: the scheduler waits for a substantive-turn cadence, then for a quiet idle window after a turn ends, then honours a floor between consecutive runs and a backoff that widens after fruitless evaluations. It refuses to auto-run when the pre-flight estimate exceeds its ceiling, reporting that instead so a human can mine deliberately. Work runs in slices bounded by a wall-clock budget: a slice that hits the budget stops at the next file boundary, reports `completed: false`, and resumes on the next slice. Any in-flight slice is aborted the moment the user starts a new turn, so background upkeep never delays a real request.

`status` surfaces that state: whether a slice is running, turns since the last mine, the current idle streak, when the last run happened, whether a truncated run is pending resumption, and the reason behind the most recent decision.

## Settings

| Key | Type | Default | Effect |
|---|---|---|---|
| `memory.backend` | `string` | `off` | Must be `mempalace-native` for this tool to exist. `createIf` returns `null` for every other value. |

Palace configuration — database path, search limits, wake-up token budget, and whether Smart Mining ingests automatically — is read by the backend from its own configuration and reported through `status`. It is deliberately not accepted as tool parameters.

## Modes / Variants
- Retrieval (`search`, `get`, `list`, `status`) is read-only and cheap.
- Curation (`save`, `diary`) writes one row and is effectively instant.
- Maintenance (`sync`) is a metadata pass over known source paths, with no file reads.
- Ingest (`mine`) is the only expensive action, and the only one with a dry run.
- Subagents get no scheduler: automatic mining belongs to the top-level session, so `status` inside a `task` child reports Smart Mining as absent instead of failing.

## Side Effects
- Filesystem: opens the palace database, creating it and its parent directory on first use. `mine` reads the target tree in a child process; `plan` only stats it.
- Process: `mine` uses the mine worker subprocess, released when the session disposes.
- Network: none. Embeddings, when active, come from the local embeddings worker.
- Session state: reads the state the backend installed. `save`, `diary`, `mine`, and `sync` write to the palace; nothing else is mutated.
- Cancellation: `untilAborted(...)` unblocks on abort, and the signal reaches search, mine, and sync, so an aborted mine stops at the next file boundary.

## Limits & Caps
- Availability requires `memory.backend: mempalace-native`.
- `limit` is clamped by the backend; the vault enforces a hard ceiling on drawer listings regardless of what is asked for.
- Mine runs are bounded by a maximum file size, a maximum file count, and — for scheduled slices — a wall-clock budget. Hitting any of them reports `completed: false`.
- Mine warnings are per-file and capped by the miner, so a tree full of unreadable files cannot flood the result.
- Search degrades to lexical-only when no embedder is available; it never fails for that reason.
- Derived titles are clamped to 72 characters with an ellipsis.

## Errors
- Throws `MemPalace native backend is not initialised for this session.` when `memory.backend` is `mempalace-native` but no state was installed — typically a backend that failed to start, or a surface that never got the tool-session hook wired.
- Throws a message naming both the missing field and the action when a required field is absent, for example ``The `query` field is required for `mempalace search`.`` The same shape covers `content` for `save`, `id` for `get`, and `dir` for `mine`. These are raised before any work, and before the failure path below.
- Everything the store can legitimately fail at — no embedder, an unreadable file, an unavailable mine worker, a scheduler that does not exist in a subagent — arrives as ordinary data and renders as prose, not an error, because a misconfigured memory store must never break an agent turn.
- **Zero-value failure sentinels.** Because the session surface never throws and its return types are non-optional, an unrecoverable vault error degrades to the zero value of the declared type. Most of those are honest — empty lists, all-zero stats, `checked: 0, pruned: 0`, a `completed: false` mine carrying a warning — and render as ordinary empty results. Two are not: a failed `save` returns `{ id: "", created: false, updated: false }`, which is byte-for-byte identical to a duplicate, and a failed diary write returns an entry with an empty id. The tool checks for the empty id on both paths and reports the failure, so it can never answer "already filed" or "wrote diary entry" about something that was never stored.
- Anything else is a genuine fault. It is logged as `mempalace failed` with the action, normalised to an `Error`, and re-raised, so a broken vault surfaces as a tool error instead of a convincing but empty success.

## Notes
- **No Python.** This palace is pure TypeScript on `bun:sqlite`, with FTS5 for lexical matching and the local embeddings worker for vectors. It shares the wings/rooms/drawers vocabulary with the separate Python-backed `mempalace` backend and nothing else — no MCP bridge, no CLI shell-out, no interpreter on `PATH`. A machine with no Python runs the whole store.
- Wing names are derived from the project directory: lowercased, characters outside `[a-z0-9_]` collapsed to underscores, leading and trailing underscores stripped, falling back to `workspace`. Every surface derives them the same way, so a project maps to one wing no matter which one wrote first.
- Drawers written through this tool are stamped `origin: manual` and `source: mempalace`, which distinguishes them from mined and diary material.
- Drawers deduplicate on a content hash scoped to the wing, so re-saving the same note is reported as a duplicate rather than filed twice.
- A `diary` read with no `wing` spans every wing, which is the widest useful "recent"; a `diary` write always targets one wing, defaulting to the session's.
- `sync` prunes drawers whose source file vanished; it does not re-read the survivors. Use `mine` for that.
- The backend also injects a compact wake-up context into the system prompt at session start. That is a separate path, not something this tool produces.
