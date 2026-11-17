#!/usr/bin/env bash
# Verify a claimed base tag without any candidate code or objects.
#
# usage: verify-base.sh <base tag> <commit>
# env:   UPSTREAM_URL GH_TOKEN GH_REPO
#        MAX_STACK (default 50)  MAX_NEWER_TAGS (default 100)
#
# 1. upstream has the tag (peeled if annotated) and it is a `-nightly.` tag;
# 2. the repository's compare API says the commit is `ahead` of the tag's commit
#    by 1..MAX_STACK with behind_by 0, so the stack sits right on that tag;
# 3. no newer upstream nightly tag is an ancestor of the commit (checked with
#    the same API for up to MAX_NEWER_TAGS newer tags; beyond that the
#    ahead_by bound from step 2 is what limits the claim);
# 4. the claimed build number does not exceed upstream's highest nightly.
# A lying build job therefore cannot push versionCode towards the cap.
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

base="${1:?base tag}"
commit="${2:?commit}"
require_match "base tag" "$RE_NIGHTLY_TAG" "$base"
require_match "commit" "$RE_SHA" "$commit"
max_stack="${MAX_STACK:-50}"
max_newer="${MAX_NEWER_TAGS:-100}"
repo="${GH_REPO:?}"

declare -A direct=() peeled=()
while read -r sha ref; do
  [[ $sha =~ $RE_SHA ]] || continue
  name="${ref#refs/tags/}"
  if [[ $name == *'^{}' ]]; then peeled[${name%'^{}'}]="$sha"; else direct[$name]="$sha"; fi
done < <(git ls-remote --tags "${UPSTREAM_URL:?}" 'refs/tags/v*-nightly.*')

tag_sha() { echo "${peeled[$1]:-${direct[$1]:-}}"; }
base_sha="$(tag_sha "$base")"
[[ -n $base_sha ]] || die "upstream has no tag $base"

base_number="$(nightly_build_number "$base")"
highest=0
newer=()
for name in "${!direct[@]}"; do
  [[ $name =~ $RE_NIGHTLY_TAG ]] || continue
  n="$(nightly_build_number "$name")"
  ((10#$n > highest)) && highest=$((10#$n))
  ((10#$n > 10#$base_number)) && newer+=("$name")
done
((10#$base_number <= highest)) || die "build number $base_number exceeds upstream's highest nightly $highest"

compare() { gh api "repos/$repo/compare/$1...$commit" --jq '[.status, .ahead_by, .behind_by] | @tsv' 2>/dev/null; }

read -r status ahead behind < <(compare "$base_sha") || die "the repository cannot compare $base to $commit"
[[ $status == ahead && $behind == 0 ]] || die "$commit is not directly ahead of $base (status $status, behind $behind)"
((ahead >= 1 && ahead <= max_stack)) || die "$commit is $ahead commits above $base (allowed 1..$max_stack)"

if ((${#newer[@]} > max_newer)); then
  echo "::warning::${#newer[@]} newer nightly tags; checking only the ahead_by bound" >&2
else
  for name in "${newer[@]}"; do
    sha="$(tag_sha "$name")"
    if out="$(compare "$sha")" && [[ ${out%%$'\t'*} == ahead || ${out%%$'\t'*} == identical ]]; then
      die "newer nightly $name is an ancestor of $commit; the base is not the newest"
    fi
  done
fi
echo "base $base verified ($ahead commits above it)"
