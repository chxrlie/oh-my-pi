# Update overlay

`omp update` normally downloads the upstream release asset and swaps it in as the installed executable. That is correct for an unmodified install and wrong for anyone carrying local patches — an in-tree memory backend, an experimental tool, a local fix — in a dev checkout: every update silently reverts the machine to stock upstream, so the patch cannot be dogfooded or debugged against a current release.

The overlay path keeps both. Given a checkout whose branch holds the local commits, the updater rebases that branch onto the upstream release tag, builds a binary from the result, and installs it through the same backup/verify/rollback swap the download path uses. The installed binary is `upstream <version> + local patches` rather than either one alone.

Overlay updates apply only to standalone-binary installs. See [Limitations](#limitations).

## Setup

```yaml
update:
  overlayRepo: /home/you/Projects/oh-my-pi
  overlayBranch: feat/my-patches
  overlayRemote: ""
```

| Setting                | Default | Description                                                                                                                  |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `update.overlayRepo`   | `""`    | Path to the overlay checkout. This is the on/off switch: empty means no overlay, and `omp update` behaves exactly as before.  |
| `update.overlayBranch` | `""`    | Branch that must already be checked out in the overlay repo. Empty accepts whichever branch is active.                       |
| `update.overlayRemote` | `""`    | Remote carrying upstream release tags. Empty auto-detects the remote whose URL points at `can1357/oh-my-pi`.                 |

All three live under **Startup & Updates** in settings.

Leaving `update.overlayRemote` empty is the usual choice. Detection is by URL, not by name, so a fork checkout whose `origin` is the fork and whose `upstream` is `can1357/oh-my-pi` resolves to `upstream` without configuration. Set the key explicitly only when the checkout has no remote pointing at the upstream slug, or when several do and the wrong one wins. A configured remote name that does not exist in the checkout is an error, not a fallback.

`update.overlayBranch` is a guard, not an instruction: the updater never switches branches for you.

## Update sequence

With an overlay configured, `omp update` runs:

1. Verify the overlay path is a git checkout and read its top level.
2. Refuse if the working tree is dirty, if HEAD is detached, or if the checked-out branch is not `update.overlayBranch`.
3. Pick the upstream remote (configured name, else URL match, else `upstream`/`origin`, else the sole remote).
4. `git fetch --force <remote> refs/tags/v<version>:refs/tags/v<version>`.
5. Rebase the overlay branch onto `v<version>`. Skipped when the tag is already an ancestor of HEAD.
6. `bun install` at the repo root.
7. `bun run build` in `packages/coding-agent`, producing `packages/coding-agent/dist/omp` (`omp.exe` on Windows).
8. Swap that binary in via the normal update install: back up the current executable, verify the new one reports the expected version, roll back if it does not.
9. Write the stamp `<binary>.overlay.json` — `{"version": "<release>", "commit": "<overlay HEAD after rebase>"}`.

`omp update --check` prints the plan (checkout, branch, remote, target tag) and installs nothing.

## The bug-fix loop

Commit a patch in the overlay checkout, re-run `omp update`, get a binary with it. Upstream does not have to have moved: the release tag is already an ancestor of the overlay HEAD, so step 5 is skipped and the run goes straight to rebuilding.

That works because the decision to rebuild compares the stamp against reality rather than comparing version numbers. A rebuild happens when any of these hold:

- no stamp beside the installed binary,
- `stamp.version` differs from the latest release version,
- `stamp.commit` differs from the overlay branch's current HEAD,
- the overlay HEAD cannot be read at all — the update runs and reports the real error instead of claiming everything is current.

Otherwise the run short-circuits on `Already up to date`, as it would without an overlay.

So `--force` is not needed for the patch loop; it is only the usual "reinstall the same version anyway" escape hatch (which does rebuild a configured overlay). `--no-overlay` ignores `update.overlayRepo` for that run and installs the stock release binary, which is the way back to unmodified upstream.

## Safety rules

The updater rewrites the commit your checkout sits on, so it is deliberately unhelpful in the cases where guessing could lose work.

**A dirty checkout is refused.** Commit or stash first. There is no auto-stash: a stash that fails to pop later turns a routine update into data loss, so the updater refuses and names the repo instead. No git command that mutates the checkout runs before this check.

**The branch must already be checked out.** Detached HEAD is refused, and so is being on a branch other than the configured one. Switch it yourself (`git -C <repo> switch <branch>`) and re-run.

**A conflicting rebase is aborted.** The updater runs `git rebase --abort` and leaves the checkout exactly as it was found, then reports the conflict. Resolve it manually in the overlay repo (`git rebase v<version>`) and re-run the update.

**A successful rebase is kept even when the build fails.** This is intentional: the rebase is the state you asked for — patches carried onto the new release — and a `bun install` or build failure is usually the thing you now need to fix on top of it. Nothing is rolled back automatically. The error hint prints the pre-rebase commit as

```text
to undo the rebase: git -C <repo> reset --hard <sha>
```

and that is the only way back to the previous base. The installed binary is untouched in this case; it is only replaced once a build has actually produced an executable.

Every expected failure prints as `Overlay update failed: <message>` followed by its hint, with no stack trace.

## Limitations

An overlay is refused when `omp` is managed by brew, mise, bun, or npm, because a locally built binary has nowhere sensible to go inside a package manager's install tree. The error names the detected method and tells you to clear `update.overlayRepo` or pass `--no-overlay` to install the stock release for that manager.

The build is a full release build of the repo, so an overlay update takes minutes rather than the seconds a download takes.

## See also

- [settings.md](settings.md) — the `update.overlay*` keys among the rest of the settings surface.
- [user-facing-packages.md](user-facing-packages.md) — how the standalone binary and the package-manager installs differ.
