#!/usr/bin/env bash
# Write the build's metadata JSON.
# usage: write-metadata.sh <out> ; env: COMMIT VERSION_NAME VERSION_CODE BASE_TAG TOOLCHAIN_ID
set -euo pipefail
jq -n \
  --arg commit "${COMMIT:?}" \
  --arg versionName "${VERSION_NAME:?}" \
  --arg versionCode "${VERSION_CODE:?}" \
  --arg baseTag "${BASE_TAG:?}" \
  --arg toolchain "${TOOLCHAIN_ID:?}" \
  '{commit: $commit, versionName: $versionName, versionCode: $versionCode, baseTag: $baseTag, toolchain: $toolchain}' \
  >"${1:?out}"
