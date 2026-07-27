# usage

> Reports what the current session and the current project have spent: live token tallies with a per-model and subagent split, plus per-project and per-model estimated cost from the local SQLite ledger.

## Source
- Entry: `packages/coding-agent/src/tools/usage.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/usage.md`
- Cost ledger: `packages/coding-agent/src/usage/cost-ledger.ts`
- Project-name resolution: `packages/coding-agent/src/usage/project-resolver.ts`
- Subagent usage guard (shared with the stats tracker): `taskToolUsage` in `packages/coding-agent/src/session/session-stats.ts`

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `action` | `"session" \| "project" \| "models"` | Yes | Which report to produce. |
| `scope` | `"current" \| "all"` | No | Ledger scope for `project`/`models`. `current` (default) narrows to the project the working directory resolves to; `all` reports every project in the ledger. Ignored by `session`. |
| `since` | `string` | No | Ledger window for `project`/`models`: `today`, `7d`, `30d`, `all`. Defaults to `30d`. Ignored by `session`, which always reports the whole session. |

## Outputs
- `session`:
  - A `Session usage` block — input, output, cache-read, cache-write, and total tokens, then `Estimated cost`. Orchestration tokens and premium requests appear only when greater than zero.
  - A `By model (orchestration only)` table — model, provider, cost, tokens, message count — sorted most expensive first.
  - A `Subagents (task tool)` line — cost, tokens, and call count folded out of `task` tool results, or `none`.
  - `details = { action: "session", costUsd, rowCount }`
- `project`: `Project cost — <window> (<scope>)` followed by one `<project>  <cost>  <tokens>  <sessions>  <last seen>` row per project, most expensive first, then a `Total:` line when more than one project matched. `details = { action: "project", since, project?, costUsd, rowCount }`
- `models`: `Model cost — <window> (<scope>)` followed by one `<model>  <provider>  <cost>  <tokens>  <requests>` row per model, most expensive first, then a `Total:` line. `details = { action: "models", since, project?, costUsd, rowCount }`
- An empty ledger is a normal result, not an error: `No ledger entries for <scope> (<window>).` followed by a pointer at the `usage.projectLedger` setting.
- An unrecognized `since` returns `isError: true` listing the valid windows. A session with no usage statistics available returns `isError: true`.

## Flow
1. `UsageTool.createIf(session)` returns `null` unless `usage.enabled` is true.
2. `session` reads `session.getUsageStatistics()` for the totals, then walks `session.sessionManager.getEntries()` once:
   - assistant messages accumulate `usage.totalTokens` and `usage.cost.total` keyed by `message.model`, recording each distinct `message.provider`;
   - `toolResult` entries with `toolName === "task"` are read through `taskToolUsage(details)` — the same guard `SessionStatsTracker` uses — and accumulate into the single subagent line.
3. `project` and `models` validate `since`, convert it to an inclusive epoch-ms lower bound (`all` sends no bound, `today` uses local midnight), and resolve the project name unless `scope` is `all`.
4. The resolved window and project are handed to `queryProjectTotals(...)` / `queryModelTotals(...)`. Both swallow their own storage failures and return `[]`, so a missing or unreadable ledger renders as "no entries" rather than an error.

## Modes / Variants
- `session` — live, in-memory, always available while a session has statistics. Independent of the ledger and of `usage.projectLedger`.
- `project` — "what has this project cost me?" Use `scope: "all"` to compare projects against each other.
- `models` — the same ledger sliced by model and provider, for spotting which model is doing the spending.

## Settings

| Key | Type | Default | Effect |
|---|---|---|---|
| `usage.enabled` | `boolean` | `true` | Exposes the tool. Off means `UsageTool.createIf` returns `null` and the tool is absent from the schema. |
| `usage.projectLedger` | `boolean` | `true` | Records token spend and estimated cost per project into the local SQLite ledger. Off means nothing new is written; `project` and `models` still read whatever was recorded earlier. |

## Project names
Project names are **not** chosen by the agent. They are resolved with wakatime-cli's own precedence, so a directory gets the same name here that a WakaTime editor plugin would give it:

1. the first non-empty line of the nearest `.wakatime-project` file at or above the directory;
2. the first matching `[projectmap]` rule in `~/.wakatime.cfg` (regex key, name template value);
3. the folder name of the nearest ancestor containing a `.git` entry;
4. the directory's own basename as a last resort.

Results are cached per directory for the life of the process; `clearProjectNameCache()` resets it.

## Storage & privacy
- The ledger is a SQLite database at `~/.omp/usage-ledger.db` (override the path with `OMP_USAGE_LEDGER_DB`). WAL mode, `0600` permissions.
- It is **local only**. The tool opens no sockets and the ledger is never transmitted, synced, or uploaded — unlike the WakaTime integration, which does send data upstream.
- Rows hold a project name, a session id, a model/provider pair, four token counts, an estimated USD figure, and a timestamp. No prompts, no file paths, no code.
- Deleting the file is safe and is the supported way to reset history; it is recreated on the next recorded message.

## Side Effects
- Filesystem: opens (and, on first use, creates) the ledger database. `project`/`models` with `scope: "current"` also read `.wakatime-project` files, `~/.wakatime.cfg`, and probe for `.git` while resolving the project name.
- Network: none.
- Session state: reads `cwd`, `settings`, `getUsageStatistics()`, and `sessionManager.getEntries()`. Writes nothing.

## Limits & Caps
- Availability requires `usage.enabled`.
- `since` is validated against `today`, `7d`, `30d`, `all`; anything else is rejected before the query runs.
- `session` degrades to totals-only when the session exposes no `sessionManager`, and errors only when `getUsageStatistics` itself is absent.
- Ledger history starts when `usage.projectLedger` was first enabled. Sessions recorded before then are simply not there.

## Errors
- `Unknown since "<value>". Valid: today, 7d, 30d, all.`
- `Session usage statistics are unavailable in this context.` when the session exposes no `getUsageStatistics`.
- Ledger read failures are not surfaced as errors — they collapse into the empty-ledger message.

## Notes
- **Costs are estimates.** They are computed from the model catalog's published pricing at the time each message was recorded, not from provider billing. Treat them as a scale indicator, never as an invoice. Cached-token pricing, negotiated rates, subscription plans, and provider-side rounding all cause drift.
- `session` totals include subagent spend; the by-model rows do not. The `Subagents (task tool)` line is the difference, so orchestration and subagent cost stay separable.
- The human-facing `/usage` slash command reports provider-side quota limits and is a different view. This tool is the agent-facing one and adds the per-project ledger.
