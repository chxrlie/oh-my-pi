# MemPalace native memory backend

`memory.backend: mempalace-native` runs a MemPalace-shaped long-term memory store implemented entirely in TypeScript. Unlike [`mempalace`](mempalace-memory-backend.md), which drives the Python `mempalace` package over MCP stdio and its CLI, this backend has **no Python dependency at all**: the store is `bun:sqlite`, the lexical index is FTS5, and the optional vector leg reuses the same local embeddings subprocess Mnemopi uses.

The two backends are independent and mutually exclusive. Selecting one never touches the other's data.

```yaml
memory:
  backend: mempalace-native
```

## The palace

The vocabulary matches the MemPalace concepts:

| Concept    | Meaning                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------- |
| **Wing**   | One project. Derived from the working directory's basename, lowercased, non-`[a-z0-9_]` collapsed to `_`, falling back to `workspace`. |
| **Room**   | A grouping inside a wing. Mined files use their directory path; explicit saves default to `notes`. |
| **Drawer** | One stored unit of memory: title, content, provenance, tags, timestamps.                   |
| **Diary**  | Dated free-text notes, filed per wing outside the room hierarchy.                          |

Drawers are content-addressed. The dedup key is a SHA-256 of the content (CRLF normalized, trailing whitespace trimmed) scoped to the wing, so filing the same material twice yields one drawer, and the same content in two projects stays separate.

## Retrieval

Search is hybrid by default: an FTS5 lexical leg and a vector leg, fused with reciprocal rank fusion. Each hit reports whether it was found lexically, by vector, or by both.

The vector leg is optional and degrades silently. With `mempalaceNative.embeddings` off, no embedder available, or a failed embed, the search runs lexical-only and says so in its `message` rather than returning nothing. Arbitrary user prose is safe as a query — FTS operator characters are stripped and each surviving token is quoted, so a query like `refresh" -token (rotation)*` matches instead of raising a syntax error.

On session start the backend injects a **wake-up** block into the system prompt: palace size, a wing/room inventory, a few recent drawer excerpts, and recent diary lines, shed from the tail to fit `mempalaceNative.wakeUpTokenBudget`. Recalled palace material is background context, not instructions; current user messages and tool output take precedence.

## Smart Mining

Mining a project into the palace is the expensive half of the system — a directory walk, a read and a hash per file, then chunking. Four mechanisms keep that off the agent's critical path.

**A subprocess owns the work.** The walk, reads, hashing and chunking all run in a dedicated child process, because every one of those is synchronous and would otherwise block the event loop for the whole mine. The parent only diffs the ledger and writes drawers. The child sends one file and waits for the parent's acknowledgement before walking on, so a slow vault throttles the walk instead of building an unbounded backlog in the parent's heap.

**A ledger makes re-mining nearly free.** Every mined file records its size, mtime and content hash. A later run skips any file whose size and mtime still match — without opening it. In practice a re-mine of an unchanged tree degrades from minutes of hashing to a stat walk.

**A stat-only pre-flight decides whether to bother.** Before any scheduled run, the miner counts candidate files and classifies them against the ledger. Zero changed files means the run is skipped entirely. An estimate above `mempalaceNative.mineMaxAutoEstimatedMillis` is refused for automatic triggers and reported instead, so a large first ingest is a deliberate act rather than a surprise stall.

**The scheduler only spends idle time.** Automatic mining runs after a quiet period following a completed turn, never during one, and in bounded slices. A new user turn aborts an in-flight slice immediately. Runs that hit their budget report as incomplete and resume in the next idle window. Consecutive fruitless evaluations widen an exponential backoff. Subagents share the parent's palace but never attach a scheduler, so concurrent subagents cannot multiply the cost.

Automatic mining is **off by default** (`mempalaceNative.autoIngest`). Explicit mining through the [`mempalace`](tools/mempalace.md) tool always bypasses the cadence gates, since the user is asking directly.

Session transcripts are mined differently from code. A target at or under the harness's own session-log root is mined in *convos* mode, which parses each transcript into one drawer of role-prefixed dialogue and drops tool traffic. Mining those logs as if they were source code would chunk raw JSONL and flood the palace with noise.

`sync` prunes drawers whose source file has been deleted, and forgets the file's ledger entry so a later re-creation mines cleanly.

## Settings

| Setting                                       | Default                                       | Description                                                        |
| --------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `mempalaceNative.dbPath`                       | `<agentDir>/mempalace-native/palace.db`        | Palace database location. `:memory:` is accepted for ephemeral use. |
| `mempalaceNative.embeddings`                   | `true`                                         | Enable the vector leg; lexical search works regardless.             |
| `mempalaceNative.searchLimit`                  | `10`                                           | Default hits per search, capped at 50.                              |
| `mempalaceNative.wakeUpTokenBudget`            | `900`                                          | Ceiling on the injected wake-up block.                              |
| `mempalaceNative.autoIngest`                   | `false`                                        | Enable Smart Mining's automatic runs.                               |
| `mempalaceNative.ingestIntervalMessages`       | `15`                                           | Substantive user turns between cadence evaluations.                 |
| `mempalaceNative.mineBudgetMillis`             | `4000`                                         | Wall-clock ceiling per mine slice.                                  |
| `mempalaceNative.mineIdleDelayMillis`          | `2000`                                         | Quiet period after a turn before an idle mine may start.            |
| `mempalaceNative.mineMinIntervalMillis`        | `60000`                                        | Floor between two runs, regardless of trigger.                      |
| `mempalaceNative.mineMaxAutoEstimatedMillis`   | `120000`                                       | Refuse automatic runs estimated above this; report instead.         |

A non-numeric, negative or unreadable numeric setting falls back to its default rather than being coerced to `0`.

## Graceful degradation

A missing embeddings stack, a worker that fails to spawn, an unreadable file or a corrupt row must never break a session. Every entry point logs and returns an empty or zero result instead of throwing: search degrades to lexical, mining reports warnings and partial counts, and the scheduler refuses rather than retrying blindly. The one deliberate exception is opening the database — a palace path that cannot be opened is a configuration mistake, and silently substituting an in-memory store would turn it into invisible data loss.

## Tool surface

With this backend selected, the [`mempalace`](tools/mempalace.md) builtin tool becomes available, exposing search, save, drawer and wing/room browsing, diary, mining (including a `plan` dry run), sync and status.
