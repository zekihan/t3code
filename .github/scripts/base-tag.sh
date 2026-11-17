#!/usr/bin/env bash
# Print the upstream nightly tag the commit sits directly on.
#
# usage: base-tag.sh [commit]            (run inside the repository)
# env:   TAG_NAMESPACE  where upstream tags were fetched (default refs/upstream-tags)
#        MAX_STACK      most commits allowed above the tag (default 50)
#
# The base is the newest (highest counter) `-nightly.` tag that is an ancestor of
# the commit. Preview tags and the fork's own tags do not match the pattern. The
# commits above it must be a linear stack: no merges, no other nightly in between
# (implied by "newest"), and at most MAX_STACK commits.
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

commit="${1:-HEAD}"
ns="${TAG_NAMESPACE:-refs/upstream-tags}"
max_stack="${MAX_STACK:-50}"

commit="$(git rev-parse --verify "$commit^{commit}")" || die "unknown commit"

best_tag=""
best_number=-1
while read -r ref; do
  tag="${ref#"$ns"/}"
  [[ $tag =~ $RE_NIGHTLY_TAG ]] || continue
  tip="$(git rev-parse --verify "$ref^{commit}" 2>/dev/null)" || continue
  git merge-base --is-ancestor "$tip" "$commit" || continue
  number="$(nightly_build_number "$tag")"
  if ((10#$number > best_number)); then
    best_number=$((10#$number))
    best_tag="$tag"
  fi
done < <(git for-each-ref --format='%(refname)' "$ns")

[[ -n $best_tag ]] || die "no upstream nightly tag is an ancestor of $commit"

base="$(git rev-parse "$ns/$best_tag^{commit}")"
if [[ -n "$(git rev-list --merges "$base..$commit")" ]]; then
  die "the stack above $best_tag contains a merge commit"
fi
count="$(git rev-list --count "$base..$commit")"
((count >= 1)) || die "$commit is $best_tag itself, not a stack on it"
((count <= max_stack)) || die "the stack above $best_tag has $count commits (limit $max_stack)"

echo "$best_tag"
