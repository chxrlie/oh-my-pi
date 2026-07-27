Report the user's WakaTime coding-time statistics.

<instruction>
Pick one `action`:
- `today` — today's grand total plus a per-project breakdown.
- `stats` — the same breakdown over `range`.
- `projects` — every project WakaTime has seen, sorted by name.
- `project` — the project name the current working directory resolves to, and which rule produced it.
- `status` — local setup: `wakatime-cli` path, whether an API key was found, the API URL, heartbeat settings, and the offline queue depth.

`range` applies to `stats` only (`today` always reports today): `today`, `yesterday`, `last_7_days`, `last_30_days`, `last_6_months`, `last_year`. Defaults to `last_7_days`.
</instruction>

<output>
Durations arrive pre-formatted from WakaTime (`4 hrs 12 mins`). Projects are listed longest-first; projects with no recorded time in the window are omitted. `status` reports whether a key was found, never the key itself. `project` reports the name, the rule behind it (`.wakatime-project` file, `[projectmap]` rule, git repository folder, or bare directory name), and the directory it was resolved for.
</output>

<critical>
Reports time ALREADY recorded upstream. This is NOT a timer: it never starts, stops, or backfills tracking, and heartbeats from the current turn may not have flushed yet — a fresh session can legitimately show zero.
</critical>
