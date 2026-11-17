# Weekly upkeep

`weekly.sh` keeps the fork's patch stack on the newest upstream nightly. See
"Weekly upkeep" in `docs/android-fork.md` for the design.

```
scripts/upkeep/weekly.sh [--repo DIR] [--dry-run] [--report FILE]
```

It fetches `origin` and `upstream`, moves `mesh` to the newest published
(non-draft, non-pre-release) release tag, and picks the rebase source: `candidate`
when it is ahead of `mesh` with no release at its tip, else `mesh`. It replays the
stack onto the newest `v*-nightly.*` tag (highest build number; preview tags are
ignored) in a temporary worktree, force-pushes `candidate` with a lease and
dispatches `release.yml`. It installs and runs no upstream code. Upstream edits to
`.github/workflows` are resolved by deleting them again.

Progress goes to stderr; a JSON report (status, tags, applied and remaining
commits, actions taken) goes to stdout or `--report FILE`.

| Exit | Meaning |
|---|---|
| 0 | Done, up to date, held pre-release, or an open PR into `candidate` (nothing touched) |
| 1 | Error (dirty tree, missing remote, no nightly tags, ...) |
| 2 | Usage |
| 3 | Conflict: `candidate` pushed with the commits that applied; the rest are in the report |

`--dry-run` still fetches and rebases locally but prints the pushes and dispatches
instead of running them. `weekly-task.md` is the prompt for the scheduled agent.
`test.sh` runs the scenarios against throwaway repositories with a stub `gh`.
