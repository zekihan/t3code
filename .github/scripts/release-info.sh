#!/usr/bin/env bash
# Helpers over the published releases (NDJSON from `gh api --paginate --jq '.[] | {...}'`).
#
# usage: release-info.sh target-sdk <releases.ndjson>
#          targetSdkVersion recorded by the newest published release that is not
#          a pre-release; empty when there is none.
#        release-info.sh show <releases.ndjson> <tag>
#          commit, version_name, toolchain and base_tag recorded for one release.
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

cmd="${1:?command}"
file="${2:?releases file}"

case "$cmd" in
target-sdk)
  jq -sr '
    [ .[] | select(.prerelease == false) | (.body // "")
      | capture("(?m)^t3mesh-target-sdk: (?<n>[0-9]{1,3})\\s*$") | .n ][0] // ""' "$file"
  ;;
show)
  tag="${3:?tag}"
  [[ $tag == v* ]] || die "tag must start with v"
  name="${tag#v}"
  require_match "tag" "$RE_RELEASE_NAME" "$name"
  body="$(jq -sr --arg t "$tag" '[ .[] | select(.tag_name == $t) | (.body // "") ][0] // empty' "$file")"
  [[ -n $body ]] || die "no release $tag"
  line() { sed -n "s/^t3mesh-$1: \(.*[^[:space:]]\)[[:space:]]*\$/\1/p" <<<"$body" | head -n 1; }
  commit="$(line commit)"
  toolchain="$(line toolchain)"
  base="$(line base)"
  require_match "release commit" "$RE_SHA" "$commit"
  require_match "release toolchain id" "$RE_TOOLCHAIN_ID" "$toolchain"
  require_match "release base tag" "$RE_NIGHTLY_TAG" "$base"
  [[ $name == "${base#v}+mesh."* ]] || die "release $tag does not belong to its base tag"
  printf 'commit=%s\nversion_name=%s\ntoolchain=%s\nbase_tag=%s\n' "$commit" "$name" "$toolchain" "$base"
  ;;
*) die "unknown command $cmd" ;;
esac
