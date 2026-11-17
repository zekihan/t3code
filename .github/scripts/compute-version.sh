#!/usr/bin/env bash
# Compute versionName and versionCode from the published releases.
#
# usage: compute-version.sh <release|rollback> <base-tag> <releases.ndjson> [original-version-name]
#
# releases.ndjson holds one JSON object per release (drafts excluded by the
# caller): {tag_name, prerelease, body, target_commitish}.
#
# The source of truth for published versionCodes is a body line
# `t3mesh-version-code: <n>` that publish-release.sh writes into every release.
# Releases without the line (made by hand) are ignored with a warning.
#
# release:  versionName = <nightly>+mesh.<rev>, rev = 1 + highest published rev
#           for that nightly (rollbacks do not count), 1..99
#           versionCode = max(build*100 + rev, highest + 1)
# rollback: versionName = <original>.rollback[.<n>]; versionCode = highest + 1
#
# Prints key=value lines: version_name, version_code, highest_code.
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

mode="${1:?mode}"
base_tag="${2:?base tag}"
releases="${3:?releases file}"
original="${4:-}"

require_match "base tag" "$RE_NIGHTLY_TAG" "$base_tag"
nightly="${base_tag#v}"
build="$(nightly_build_number "$nightly")"

highest="$(jq -sr '
  [ .[] | (.body // "") | scan("(?m)^t3mesh-version-code: ([0-9]{1,10})\\s*$") | .[0] | tonumber ]
  | max // 0' "$releases")"
missing="$(jq -s '[ .[] | select(((.body // "") | test("(?m)^t3mesh-version-code: [0-9]+\\s*$")) | not) ] | length' "$releases")"
if ((missing > 0)); then
  echo "::warning::$missing release(s) carry no t3mesh-version-code line and are ignored" >&2
fi
((highest < MAX_VERSION_CODE)) || die "highest published versionCode $highest leaves no room"

case "$mode" in
release)
  max_rev="$(jq -s --arg p "v$nightly+mesh." '
    [ .[] | .tag_name | select(startswith($p)) | ltrimstr($p) | select(test("^[0-9]+$")) | tonumber ]
    | max // 0' "$releases")"
  rev=$((max_rev + 1))
  ((rev >= 1 && rev <= 99)) || die "revision $rev for $nightly is outside 1..99"
  name="$nightly+mesh.$rev"
  code=$((10#$build * 100 + rev))
  ((code > highest)) || code=$((highest + 1))
  ;;
rollback)
  require_match "original versionName" "$RE_RELEASE_NAME" "$original"
  [[ $original == "$nightly+mesh."* ]] || die "original versionName does not belong to $base_tag"
  name="$original.rollback"
  if jq -se --arg t "v$name" 'any(.[]; .tag_name == $t)' "$releases" >/dev/null; then
    n=2
    while jq -se --arg t "v$name.$n" 'any(.[]; .tag_name == $t)' "$releases" >/dev/null; do
      n=$((n + 1))
    done
    ((n <= 99)) || die "too many rollbacks of $original"
    name="$original.rollback.$n"
  fi
  code=$((highest + 1))
  ;;
*) die "unknown mode $mode" ;;
esac

require_match "versionName" "$RE_VERSION_NAME" "$name"
require_version_code "versionCode" "$code"
echo "version_name=$name"
echo "version_code=$code"
echo "highest_code=$highest"
