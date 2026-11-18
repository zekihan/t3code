Weekly upkeep for the Android fork (`~/repos/github.com/zekihan/t3code` on devbox).
The live prompt is the T3 scheduled task "t3code fork weekly upkeep"; this file is
its reference copy. The owner wants it to run without them: fix, merge and release
when every check passes, and ask only when a decision is needed.

1. Run `scripts/upkeep/weekly.sh --repo <clone> --report /tmp/t3-upkeep.json`
   from `origin/main` (`git show origin/main:scripts/upkeep/weekly.sh`).
2. Exit 0: `rebased`/`dispatched` → watch the release run; on failure go to 4.
   `open_pr` → finish that PR as in 3. `held` → report (owner decision).
   `up_to_date` → done.
3. Exit 3 (conflict): branch `fix/<nightly>` from `origin/candidate`, cherry-pick
   the report's `remaining` commits, resolve keeping fork code in its own files,
   run the mobile typecheck and tests (and the native checks where the SDK
   exists), open a PR into `candidate`, merge it with rebase-merge when all
   checks pass, dispatch `release.yml` for the new tip and watch it.
4. Failed build: branch from `origin/candidate`, fix, same checks, PR, merge,
   release. Re-run an apparently flaky failure once before changing code.
5. Ask the owner (leave the PR open) only for: a conflict needing a product
   decision, checks failing after two attempts, a security refusal in the release
   job (never work around it), or a held pre-release.
6. Exit 1 or 2: diagnose once, retry once if transient, else report.
