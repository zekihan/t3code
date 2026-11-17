#!/usr/bin/env bash
# Fail unless a ref in this repository points at the expected commit.
# usage: check-ref.sh <heads/candidate | tags/<tag>> <commit>
# env:   GH_TOKEN GH_REPO
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

ref="${1:?ref}"
want="${2:?commit}"
require_match "commit" "$RE_SHA" "$want"
ref="${ref//+/%2B}"
read -r type sha < <(gh api "repos/${GH_REPO:?}/git/ref/$ref" --jq '[.object.type, .object.sha] | @tsv') ||
  die "ref $1 does not exist"
[[ $type == commit ]] || die "ref $1 is not a plain commit ref"
[[ $sha == "$want" ]] || die "$1 now points at $sha, not $want; dropping this run"
