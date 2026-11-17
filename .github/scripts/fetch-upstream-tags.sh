#!/usr/bin/env bash
# Record upstream's nightly tags in refs/upstream-tags/ without fetching objects.
#
# usage: fetch-upstream-tags.sh <upstream url> (run inside the repository)
#
# The fork holds upstream's history but pushes no upstream tags, so the tag to
# commit mapping comes from `git ls-remote`. Only `-nightly.` tags are kept
# (preview tags share the counter and are not bases), annotated tags are
# peeled, and a tag whose commit is not in the repository is skipped.
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

url="${1:?upstream url}"
declare -A direct=() peeled=()
while read -r sha ref; do
  [[ $sha =~ $RE_SHA ]] || continue
  name="${ref#refs/tags/}"
  if [[ $name == *'^{}' ]]; then
    peeled[${name%'^{}'}]="$sha"
  else
    direct[$name]="$sha"
  fi
done < <(git ls-remote --tags "$url" 'refs/tags/v*-nightly.*')

count=0
for name in "${!direct[@]}"; do
  [[ $name =~ $RE_NIGHTLY_TAG ]] || continue
  sha="${peeled[$name]:-${direct[$name]}}"
  git cat-file -e "$sha^{commit}" 2>/dev/null || continue
  git update-ref "refs/upstream-tags/$name" "$sha"
  count=$((count + 1))
done
((count > 0)) || die "no upstream nightly tag matches a commit in this repository"
echo "recorded $count upstream nightly tags"
