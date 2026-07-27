Report what this session and this project have spent — tokens and estimated cost.

<instruction>
Pick one `action`:
- `session` — live totals for the current session: input/output/cache tokens, orchestration tokens, premium requests, and cost. Followed by a per-model breakdown and a single line for `task` subagent spend, so orchestration and subagent cost stay legible.
- `project` — cost per project from the local ledger: cost, total tokens, session count, and how long ago each project was last active. Sorted most expensive first.
- `models` — the same ledger sliced by model: model, provider, cost, tokens, and request count.

`scope` applies to `project` and `models`: `current` (default) narrows to the project this working directory resolves to; `all` reports every project the ledger has seen.

`since` also applies to `project` and `models` (`session` always reports the whole session): `today`, `7d`, `30d`, `all`. Defaults to `30d`.
</instruction>

<output>
Token counts are exact. Money is rendered to two decimals from a cent upward and to four significant digits below it. `session` reports the whole session including subagents; the by-model rows cover orchestration only, with subagent spend on its own line.
</output>

<critical>
Costs are ESTIMATES computed from the model catalog's published pricing. They are not billed amounts and will not reconcile exactly with a provider invoice — never present them as one.

The ledger is local: it is written to a SQLite file on this machine and nothing is sent anywhere. `project` and `models` return nothing when `usage.projectLedger` is off, or before this project has recorded an assistant message.
</critical>
