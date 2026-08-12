Read and curate the MemPalace long-term memory store: a local palace of wings (one per project), rooms (topics inside a wing), and drawers (individual memories), plus a dated per-wing diary.

<instruction>
Pick one `action`:
- `search` — hybrid lexical + semantic retrieval across drawers. Requires `query`. Narrow with `wing`, `room`, or `limit`. Returns drawer ids, so this is how you find something to `get`.
- `save` — file one drawer. Requires `content`. `title` labels it, `room` groups it (default `notes`), `wing` selects the project partition (default this session's wing), `tags` are free-form labels. Identical content already in the wing is reported as a duplicate instead of being filed twice.
- `get` — render one full drawer by `id`. Ids come from `search` and `list`.
- `list` — walk the hierarchy. No `wing` lists the wings; `wing` alone lists that wing's rooms; `wing` plus `room` lists the drawers inside.
- `diary` — with `content`, append a dated entry to the wing's diary; without it, read recent entries. Use it for session narrative and running state, not for durable facts, which belong in a drawer.
- `mine` — ingest a directory tree into the palace. Requires `dir`. Read the warning below before using it.
- `sync` — drop drawers whose source file has vanished. Cheap. Worth running after a large delete, move, or refactor.
- `status` — palace size, whether semantic search is active, and what Smart Mining is currently doing.

Prefer `mempalace search` over the generic recall surface whenever you want a *specific* piece of stored material: a named drawer, one project's own notes, a mined excerpt of this codebase, or anything you intend to open in full with `get`. Recall answers "what do I generally know about X"; `mempalace search` finds the exact drawer that says it, and hands you the id to read it.
</instruction>

<output>
`search` returns numbered `wing/room · title` lines, each with its drawer id and a snippet. Zero matches is a normal result and says so in words — it is never an empty body. When semantic search is unavailable the result still comes back, lexical-only, with a note saying so.

`mine` with `plan: true` reports counts and an estimate and files nothing. Without it, `mine` reports what was actually written and whether the run finished or stopped on its time budget.
</output>

<critical>
`mine` is PROCESS-INTENSIVE. It walks the tree, then reads, hashes, and chunks every candidate file.

Run `plan: true` FIRST. It is a stat-only pre-flight that reports `candidateFiles`, `changedFiles`, `unchangedFiles`, and an `estimatedMillis` cost without reading a single byte or filing a single drawer. Only mine for real once the plan shows the cost is acceptable.

NEVER invoke `mine` speculatively, and NEVER aim it at a home directory, `/`, or any other large unbounded tree. Scope it to one project directory.

Routine upkeep is NOT your job. Smart Mining already re-mines incrementally in the background while the session is idle, and its ledger skips every file it can prove unchanged. Reach for `mine` only for a directory the scheduler does not cover, or when you genuinely need `force: true` to re-read files the ledger currently considers up to date — `force` discards that protection and pays the full cost again.
</critical>
