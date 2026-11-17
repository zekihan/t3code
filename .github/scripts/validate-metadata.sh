#!/usr/bin/env bash
# Validate the metadata JSON from the (hostile) build artifact.
# usage: validate-metadata.sh <file>
# Prints key=value lines (commit, version_name, version_code, base_tag,
# toolchain) only when every field matches its strict format and the fields are
# consistent with each other. Nothing from the file is used before this passes.
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

file="${1:?metadata file}"
[[ -f $file && ! -L $file ]] || die "metadata is not a regular file"
size="$(wc -c <"$file")"
((size <= 4096)) || die "metadata is larger than 4 KiB"

jq -e 'type == "object" and (keys | sort) == ["baseTag","commit","toolchain","versionCode","versionName"]
  and ([.[]] | all(type == "string"))' "$file" >/dev/null ||
  die "metadata must be an object of exactly five string fields"

field() { jq -r --arg k "$1" '.[$k]' "$file"; }
commit="$(field commit)"
version_name="$(field versionName)"
version_code="$(field versionCode)"
base_tag="$(field baseTag)"
toolchain="$(field toolchain)"

require_match "metadata commit" "$RE_SHA" "$commit"
require_match "metadata versionName" "$RE_VERSION_NAME" "$version_name"
require_version_code "metadata versionCode" "$version_code"
require_match "metadata baseTag" "$RE_NIGHTLY_TAG" "$base_tag"
require_match "metadata toolchain" "$RE_TOOLCHAIN_ID" "$toolchain"
[[ $version_name == "${base_tag#v}+mesh."* ]] || die "metadata versionName does not belong to its base tag"

printf 'commit=%s\nversion_name=%s\nversion_code=%s\nbase_tag=%s\ntoolchain=%s\n' \
  "$commit" "$version_name" "$version_code" "$base_tag" "$toolchain"
