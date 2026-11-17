#!/usr/bin/env bash
# Read a toolchain set from main and print it as lowercase key=value lines.
#
# usage: load-toolchain.sh <toolchain dir> [id]
#   Without an id the set named in <dir>/current is used. Sets live in
#   <dir>/sets/<id>.env and are immutable once a release used them.
#
# The file is parsed, never sourced: only the known keys are accepted, each
# value must match a conservative pattern, and a value still starting with TODO
# fails the run.
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

dir="${1:?toolchain dir}"
id="${2:-}"
if [[ -z $id ]]; then
  id="$(tr -d '[:space:]' <"$dir/current")"
fi
require_match "toolchain id" "$RE_TOOLCHAIN_ID" "$id"
file="$dir/sets/$id.env"
[[ -f $file ]] || die "toolchain set $id does not exist on main"

keys=(TOOLCHAIN_ID NODE_VERSION PNPM_VERSION JAVA_DISTRIBUTION JAVA_VERSION
  ANDROID_CMDLINE_TOOLS_VERSION ANDROID_CMDLINE_TOOLS_SHA256
  ANDROID_BUILD_TOOLS_VERSION ANDROID_PLATFORM_VERSION ANDROID_NDK_VERSION
  APKSIGNER_JAR_SHA256 ZIPALIGN_SHA256 AAPT2_SHA256 KOTLIN_TEST_TASK)
sha_keys=" ANDROID_CMDLINE_TOOLS_SHA256 APKSIGNER_JAR_SHA256 ZIPALIGN_SHA256 AAPT2_SHA256 "
declare -A seen=()

while IFS= read -r line || [[ -n $line ]]; do
  [[ -z $line || $line == \#* ]] && continue
  [[ $line =~ ^([A-Z0-9_]+)=([A-Za-z0-9._:+-]+)$ ]] || die "toolchain $id: malformed line"
  key="${BASH_REMATCH[1]}"
  value="${BASH_REMATCH[2]}"
  [[ " ${keys[*]} " == *" $key "* ]] || die "toolchain $id: unknown key $key"
  [[ -z ${seen[$key]:-} ]] || die "toolchain $id: duplicate key $key"
  [[ $value != TODO* ]] || die "toolchain $id: $key is still TODO"
  if [[ $sha_keys == *" $key "* ]]; then
    require_match "toolchain $id $key" "$RE_SHA256" "$value"
  fi
  seen[$key]=$value
done <"$file"

for key in "${keys[@]}"; do
  [[ -n ${seen[$key]:-} ]] || die "toolchain $id: $key is missing"
done
[[ ${seen[TOOLCHAIN_ID]} == "$id" ]] || die "toolchain $id: TOOLCHAIN_ID does not match the file name"
[[ ${seen[KOTLIN_TEST_TASK]} =~ ^:?[A-Za-z0-9:_-]+$ ]] || die "toolchain $id: bad KOTLIN_TEST_TASK"

for key in "${keys[@]}"; do
  printf '%s=%s\n' "$(tr '[:upper:]' '[:lower:]' <<<"$key")" "${seen[$key]}"
done
