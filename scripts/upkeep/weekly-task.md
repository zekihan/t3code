Weekly upkeep for the Android fork (`~/repos/github.com/zekihan/t3code`). Read
`docs/android-fork.md` on `main` ("Weekly upkeep") if anything below is unclear.
Never push `main`; never push anything except through the script and the fix
branches below.

1. Run `scripts/upkeep/weekly.sh --report /tmp/upkeep.json` from a checkout of
   `main` (use `git -C <clone> show origin/main:scripts/upkeep/weekly.sh` if your
   copy is stale). Needs a clean tree. Read the JSON `status` and the exit code.
2. Exit 0: report `status` and `message` in this thread.
   - `open_pr`: a fix PR into `candidate` is open; only report it.
   - `held`: a pre-release is waiting for the owner's device check; only report it.
   - `rebased` or `dispatched`: a build was dispatched; check it with
     `gh run list --workflow release.yml --limit 3` a few minutes later. If the
     build fails, treat it as a failed build below.
3. Exit 3 (conflict): `candidate` already holds the new nightly plus the commits
   that applied. Branch `fix/<nightly>` from `origin/candidate`, cherry-pick each
   commit in the report's `remaining` list in order (resolve conflicts, keeping
   fork code in its own files), run the mobile tests, push the branch and open a PR
   into `candidate` (`gh pr create --base candidate`). It is merged with
   rebase-merge so the stack stays separate commits. Do not merge it yourself.
4. Failed build (from step 2 or a failure issue): branch from `origin/candidate`,
   fix, run the tests, open a PR into `candidate`. Do not touch `mesh`.
5. Exit 1 or 2: diagnose once (dirty tree, missing remote, auth); if it persists,
   report the error text and stop.

Running upstream install or test scripts is allowed only while fixing (steps 3 and
4). Keep the report short: status, new nightly, links to PRs or runs.
