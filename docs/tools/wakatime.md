# wakatime

> Reports the user's WakaTime coding-time statistics: daily and ranged totals, per-project breakdowns, the known project list, how the current directory is named, and local tracker health.

## Source
- Entry: `packages/coding-agent/src/tools/wakatime.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/wakatime.md`
- Config resolution: `packages/coding-agent/src/wakatime/config.ts`
- Project-name resolution: `packages/coding-agent/src/usage/project-resolver.ts`
- REST client: `packages/coding-agent/src/wakatime/stats.ts`
- Heartbeat emitter (separate feature, same settings group): `packages/coding-agent/src/wakatime/heartbeats.ts`

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `action` | `"today" \| "stats" \| "projects" \| "project" \| "status"` | Yes | Which report to produce. |
| `range` | `string` | No | Reporting window for `stats`. One of `today`, `yesterday`, `last_7_days`, `last_30_days`, `last_6_months`, `last_year`. Defaults to `last_7_days`. Ignored by `projects`, `project`, and `status`; `today` always reports today. |

## Outputs
- `today` / `stats`:
  - `content[0].text` = `"<Range label>: <total>"`, a blank line, then one indented `<project>  <duration>` row per project, longest first.
  - An empty window collapses to `"<Range label>: no coding activity recorded"`.
  - `details = { action, range, totalSeconds, projectCount }`
- `projects`:
  - `content[0].text` = `"<n> WakaTime projects: <a>, <b>, ..."` (name-sorted) or `"No WakaTime projects found."`
  - `details = { action: "projects", projectCount }`
- `project`: three lines — `Project`, `Resolved by`, `Directory`. `details = { action: "project", project, projectSource }`, where `projectSource` is one of `file`, `projectmap`, `git`, `basename`.
- `status`: five lines — `wakatime-cli`, `API key`, `API URL`, `Heartbeats`, `Offline queue` — plus install/setup hints when the CLI or key is missing. `details = { action: "status" }`.
- Missing API key, an unknown `range`, and upstream request failures all return `isError: true` with a plain-text explanation. They never throw.

## Flow
1. `WakatimeTool.createIf(session)` returns `null` unless `wakatime.enabled` is true, so the tool is absent from the schema by default.
2. `execute(...)` resolves configuration once via `resolveWakatimeConfig({ cliPath: <wakatime.cliPath> })`. That call never throws; a missing binary or key yields `null`.
3. `status` and `project` run before the API-key guard. `status` is the diagnostic path and must work precisely when nothing else does; `project` is pure local resolution and never talks to WakaTime.
4. Every other action short-circuits with an actionable message when `config.apiKey` is `null`.
5. `today`/`stats` call `fetchSummary(config, range, fetch)`; `projects` calls `fetchProjects(config, fetch)`. Both receive `session.fetch` when the harness injects one, so proxy, CA, and fetch-policy wrappers stay in effect.
6. Zero-second projects are dropped from the breakdown; WakaTime returns an entry for every known project in the window, most of them empty.

## Modes / Variants
- `today` — today's grand total plus breakdown. Equivalent to `stats` with `range: "today"`, kept as its own action so the common case needs no argument.
- `stats` — the same report over any supported range.
- `projects` — the full project list from `GET /users/current/projects`, paginated upstream and flattened by `fetchProjects`.
- `project` — resolves `session.cwd` through wakatime-cli's own precedence: a `.wakatime-project` file at or above the directory (first non-empty line wins), then a `[projectmap]` regex from `~/.wakatime.cfg` (case-insensitive, `{0}` interpolating the first capture group), then the nearest ancestor holding a `.git` entry (directory or file, so worktrees and submodules resolve), then the bare directory name. Results are memoised per absolute directory. When several `[projectmap]` patterns match, the longest pattern wins — wakatime-cli iterates an unordered Go map there and picks arbitrarily, so this is deliberately stricter than the CLI.
- `status` — local setup only. Reports the resolved `wakatime-cli` path (or `not installed`), whether an API key was found, the API base URL, whether heartbeats are enabled and under which category, and the offline heartbeat queue depth from `wakatime-cli --offline-count` (`unavailable` when the CLI is absent).

## Settings

| Key | Type | Default | Effect |
|---|---|---|---|
| `wakatime.enabled` | `boolean` | `false` | Master switch. Off means no tool and no heartbeats — nothing is sent anywhere. |
| `wakatime.heartbeats` | `boolean` | `true` | Emit heartbeats as the agent reads and edits files. Only takes effect when `wakatime.enabled` is also on. |
| `wakatime.category` | `string` | `"ai coding"` | WakaTime category recorded for agent activity. |
| `wakatime.cliPath` | `string` | unset | Override the auto-detected `wakatime-cli` binary. |

API credentials are read, in order, from the settings override, `WAKATIME_API_KEY`, then `api_key` under `[settings]` in `~/.wakatime.cfg`. An `api_url` entry in that file overrides the default `https://api.wakatime.com/api/v1`.

## Side Effects
- Network: `GET {apiUrl}/users/current/summaries` and `GET {apiUrl}/users/current/projects`, authenticated with HTTP Basic (API key as username, empty password). `project` and `status` make no requests.
- Subprocess: `status` shells out to `wakatime-cli --offline-count`. No other action runs a subprocess.
- Filesystem: reads `~/.wakatime.cfg` during config resolution. `project` additionally walks `session.cwd` and its ancestors looking for `.wakatime-project` and `.git`. Writes nothing.
- Session state: reads `cwd`, `settings`, and the optional injected `fetch`.

## Limits & Caps
- Availability requires `wakatime.enabled`; the default is off.
- `range` is validated against the six windows the WakaTime summaries endpoint accepts. Anything else is rejected before the request is made.
- `project` and `status` are the only actions that work without an API key.
- The offline queue depth is `null`/`unavailable` whenever `wakatime-cli` is missing or the probe fails.

## Errors
- Missing key: `No WakaTime API key found.` followed by how to set `WAKATIME_API_KEY` or `api_key` in `~/.wakatime.cfg`, plus a pointer at <https://wakatime.com/api-key>. Returned as an error result, not thrown.
- `Unknown range "<value>". Valid: today, yesterday, last_7_days, last_30_days, last_6_months, last_year.`
- `WakaTime request failed: <reason>` for HTTP and transport failures. The API key is stripped from `<reason>` before it is surfaced.

## Notes
- Project names are **not** chosen by the agent. They come from the user's own `~/.wakatime.cfg [projectmap]` entries and `.wakatime-project` files, exactly as they would for an editor plugin. Heartbeats deliberately omit `--project` so those rules keep winning, and `project` reports what those rules resolve to rather than overriding them.
- This tool reports time WakaTime has already recorded. It is not a timer: it starts nothing, stops nothing, and cannot backfill. Heartbeats from the current turn may not have flushed yet, so a fresh session can legitimately report zero.
- `wakatime-cli --today` is unreliable — it prints an empty result even when data exists. All totals here come from the REST summaries endpoint instead.
- The API key is never printed. `status` reports only whether one was found.
