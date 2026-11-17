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

# Do not build a partial stack: after a rebase conflict the weekly task pushes
# candidate with only the commits that applied, and the fix PR may not exist yet.
# Compare stack sizes above each branch's own nightly base; no code is executed.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
url="${REPO_URL:-${GITHUB_SERVER_URL:-https://github.com}/$repo}"
stack_size() {
  local base
  base="$("$here/base-tag.sh" "refs/remotes/origin/$1")" || return 1
  echo "$(git rev-list --count "refs/upstream-tags/$base..refs/remotes/origin/$1") $base"
}
guard="$(
  cd "$work"
  git init -q .
  git fetch -q --no-tags --filter=blob:none "$url" \
    '+refs/heads/mesh:refs/remotes/origin/mesh' '+refs/heads/candidate:refs/remotes/origin/candidate'
  "$here/fetch-upstream-tags.sh" "${UPSTREAM_URL:-https://github.com/pingdotgg/t3code}" >/dev/null
  fetched="$(git rev-parse refs/remotes/origin/candidate)"
  if [[ $fetched != "$tip" ]]; then
    echo "skip candidate moved to $fetched while checking"
    exit 0
  fi
  c="$(stack_size candidate)" || { echo "skip cannot determine candidate's base nightly"; exit 0; }
  m="$(stack_size mesh)" || { echo "skip cannot determine mesh's base nightly"; exit 0; }
  read -r cn cb <<<"$c"
  read -r mn mb <<<"$m"
  if ((cn < mn)); then
    echo "skip candidate has $cn stack commits on $cb but mesh has $mn on $mb; a partial stack is not built"
    exit 0
  fi
  echo "ok candidate has $cn stack commits on $cb, mesh has $mn on $mb"
)"
echo "$guard"
[[ ${guard##*$'\n'} == ok\ * ]] || exit 0

if [[ ${DRY_RUN:-} == 1 ]]; then
  echo "would dispatch release.yml for $tip"
  exit 0
fi
echo "dispatching release.yml for $tip"
gh workflow run release.yml --repo "$repo" --ref main -f "commit=$tip"
