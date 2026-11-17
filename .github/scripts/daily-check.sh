#!/usr/bin/env bash
# Dispatch the release workflow for `candidate` when it is ahead of `mesh`, no
# PR targets `candidate`, no release was built from its tip and no release run
# for it is queued or in progress.
#
# env: GH_TOKEN GH_REPO  DRY_RUN=1 prints the decision instead of dispatching
# The release run's title is "Release <commit>" (run-name), which is how an
# existing run is matched to a commit.
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

repo="${GH_REPO:?}"
tip="$(gh api "repos/$repo/git/ref/heads/candidate" --jq .object.sha)"
require_match "candidate tip" "$RE_SHA" "$tip"

status="$(gh api "repos/$repo/compare/mesh...candidate" --jq .status)"
case "$status" in
ahead | diverged) ;;
*)
  echo "candidate is $status relative to mesh; nothing to build"
  exit 0
  ;;
esac

open_prs="$(gh pr list --repo "$repo" --base candidate --state open --json number --jq length)"
if ((open_prs > 0)); then
  echo "$open_prs open PR(s) target candidate; leaving it to the weekly task"
  exit 0
fi

releases="$(gh api --paginate "repos/$repo/releases?per_page=100" \
  --jq '.[] | {tag_name, target_commitish, body: (.body // "")}')"
if jq -se --arg c "$tip" 'any(.[]; .target_commitish == $c or (.body | test("(?m)^t3mesh-commit: " + $c + "\\s*$")))' <<<"$releases" >/dev/null; then
  echo "a release already exists for $tip"
  exit 0
fi

runs="$(gh run list --repo "$repo" --workflow release.yml --limit 100 --json status,displayTitle)"
if jq -e --arg t "Release $tip" 'any(.[]; .displayTitle == $t and .status != "completed")' <<<"$runs" >/dev/null; then
  echo "a release run for $tip is already queued or running"
  exit 0
fi

if [[ ${DRY_RUN:-} == 1 ]]; then
  echo "would dispatch release.yml for $tip"
  exit 0
fi
echo "dispatching release.yml for $tip"
gh workflow run release.yml --repo "$repo" --ref main -f "commit=$tip"
