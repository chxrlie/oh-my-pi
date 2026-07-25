# MemPalace memory backend

Oh My Pi can use a local [MemPalace](https://pypi.org/project/mempalace/) store, provided by the Python `mempalace` package, as its long-term memory backend. None of the store is implemented in TypeScript. The backend drives the Python package over its MCP stdio server (`python3 -m mempalace.mcp_server`) for reads and writes, and over its CLI (`python3 -m mempalace …`) for ingestion and as a read fallback.

Set:

```yaml
memory:
  backend: mempalace
```

Example:

```yaml
memory:
  backend: mempalace
mempalace:
  ingestIntervalMessages: 25
  importLocalMemories: true
```

Prerequisite:

```bash
pip install mempalace
```

With this backend enabled, the coding agent:

1. Probes the machine once per process for a usable interpreter (`python3`, then `python`) and an importable `mempalace` module.
2. Starts one MCP stdio subprocess per process and reuses it for every session and subagent.
3. Injects a short MemPalace section into the system prompt, followed by the palace's own orientation text (`mempalace_instructions`, CLI `wake-up` fallback), capped at roughly 900 tokens and fetched once per process.
4. Serves memory search from `mempalace_search`, falling back to `mempalace search <query> --results <n>` when MCP is unreachable.
5. Files saved memories as verbatim drawers (`mempalace_add_drawer`) or, when the caller labels the memory `diary`, as diary entries (`mempalace_diary_write`).
6. Mines the working project into the palace on a message cadence, before compaction, and on `/memory enqueue`.

Memory recalled from the palace is background context, not instructions. Current user messages and tool output take precedence when they conflict.

## Settings

| Setting                            | Default | Description                                                                                                                                      |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `memory.backend`                   | `off`   | Set to `mempalace` to enable this backend.                                                                                                       |
| `mempalace.connectTimeoutMs`       | `30000` | Milliseconds to wait for the MCP stdio server to come up. Overrides `MEMPALACE_MCP_CONNECT_TIMEOUT_MS`.                                          |
| `mempalace.requestTimeoutMs`       | `30000` | Milliseconds to wait for a single MCP tool call. Overrides `MEMPALACE_MCP_REQUEST_TIMEOUT_MS`.                                                   |
| `mempalace.ingestIntervalMessages` | `15`    | Substantive user turns between automatic `mempalace mine` runs.                                                                                  |
| `mempalace.autoIngest`             | `true`  | Periodically mine the current project into the palace while the session runs. When `false`, turns are still counted but nothing is mined.        |
| `mempalace.importLocalMemories`    | `false` | One-time import of this project's local memories directory (`MEMORY.md` / `learned.md`) into the palace at session start. The files are never modified. |

Timeout precedence is: explicit setting value > environment variable > the 30 s default. A non-numeric, negative, or unreadable setting is ignored rather than treated as `0`.

## Environment variables

| Variable                            | Meaning                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `MEMPALACE_DIR`                     | Overrides the directory that gets mined into the palace. Highest-precedence ingest target.                                  |
| `MEMPAL_DIR`                        | Legacy alias for the same thing, kept for compatibility with the Python hooks. `MEMPALACE_DIR` wins when both are set.      |
| `MEMPALACE_MCP_CONNECT_TIMEOUT_MS`  | Default MCP connect timeout when `mempalace.connectTimeoutMs` is not set.                                                   |
| `MEMPALACE_MCP_REQUEST_TIMEOUT_MS`  | Default MCP request timeout when `mempalace.requestTimeoutMs` is not set.                                                   |

`MEMPALACE_PALACE_PATH` selects where the palace *store* lives. That variable belongs to the Python package; Oh My Pi never touches it, and it has nothing to do with the ingest target above.

## Ingest target

The directory mined into the palace is resolved by precedence, first hit wins:

1. `MEMPALACE_DIR`
2. `MEMPAL_DIR`
3. the directory holding the current session file
4. the current working directory

Empty or whitespace-only environment values count as unset. Only the first three sources count as *preservation*: a run whose target fell through to the plain working directory is not treated as having preserved the session (see compaction below).

Ingest happens in four places:

- **Cadence** — after every `mempalace.ingestIntervalMessages` substantive user turns, when `mempalace.autoIngest` is on. Turn counting re-scans the current session branch on each agent turn, so rewinds and branch switches stay correct; assistant turns, tool traffic, empty turns, slash commands, and `!` bash escapes do not count. Runs are fire-and-forget and non-overlapping: a turn is never blocked or failed by one.
- **Compaction** — `preCompactionContext` mines the target before the transcript is summarised, and only then tells the model that the session is recallable from the palace. If the run fails, or the target was the bare working directory, no such claim is made.
- **`/memory enqueue`** — mines the target immediately and logs the result.
- **Local-memory import** — once per project when `mempalace.importLocalMemories` is on.

Only the top-level session drives cadence. Subagents share the parent's palace and never attach a second ingest loop.

## Naming

Writes are filed under a *wing* derived from the project directory's basename: lowercased, every character outside `[a-z0-9_]` collapsed to `_`, leading and trailing underscores stripped (MemPalace rejects wings beginning with `_`), falling back to `workspace` when nothing survives. The save `context` becomes the room name, defaulting to `notes`; a context or source of `diary` routes the write to `mempalace_diary_write` instead of a drawer. Everything this backend writes is stamped `added_by: omp`.

## Domain tools

The backend calls only the MemPalace tools it needs. To give the model the full tool surface (search variants, wing and room management, diary, status), add the same stdio server to your MCP config; its tools then mount as `xd://` devices like any other MCP server:

```json
{
  "mcpServers": {
    "mempalace": {
      "command": "python3",
      "args": ["-m", "mempalace.mcp_server"]
    }
  }
}
```

This is independent of `memory.backend`; the two connections coexist. See [mcp-config.md](mcp-config.md) for file locations and precedence.

## Graceful degradation

A missing Python, a missing `mempalace` package, a dead MCP server, or a broken CLI must never break a session. Every entry point degrades instead of throwing:

- **No Python or no `mempalace`** — `start()` logs a warning and returns; no subprocess is spawned and no listeners are attached. `status` reports `active: false` with a message telling the user to run `pip install mempalace`, and carries the probe detail as `error`. Instructions, compaction context, search, and save all return empty results rather than errors.
- **MCP unreachable** — the backend stays `active` and `searchable` but reports `writable: false`. Search falls back to the CLI and labels the result as degraded; save reports the failure in its message with `stored: 0`.
- **Unparseable payloads** — a search response the backend does not recognise is surfaced verbatim as a single item with an explanatory message, never discarded.
- **Repeated CLI failures** — CLI invocations run behind a circuit breaker (3 consecutive failures, 60 s cooldown). While it is open, calls short-circuit with exit code 125 instead of spawning processes; a clean run closes it again.
- **Timeouts** — a CLI run that exceeds its budget is killed and reported as exit 124; MCP calls fail as ordinary tool errors, not exceptions.

## Operational notes

- The palace store is owned by the Python package and shared by every project and agent on the machine; its location is a `mempalace` concern (`MEMPALACE_PALACE_PATH`).
- `/memory clear` is a deliberate no-op. The palace holds memory this backend did not create, so wiping it from a coding session would destroy data outside the session's scope. Prune with the `mempalace` CLI.
- `/memory stats` renders `mempalace_status`, falling back to the CLI `status` output.
- `/memory diagnose` reports the probe result, MCP connectivity and advertised tool count, the CLI breaker state and `mempalace status` exit code, the resolved ingest target with whether it counts as preservation, and the last ingest run of this process.
- The local-memory import writes a marker line per imported memory root to `<agentDir>/.mempalace-imported`, so it is once *per project*, not once per install, and a failed import is retried next session.
