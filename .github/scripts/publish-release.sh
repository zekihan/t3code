#!/usr/bin/env bash
# Create the tag and release for a verified, signed APK.
#
# usage: publish-release.sh <signed apk>
# env:   GH_TOKEN GH_REPO
#        COMMIT VERSION_NAME VERSION_CODE BASE_TAG TOOLCHAIN_ID TARGET_SDK CERT_SHA256
#        PRERELEASE (true|false)  HOLD_NOTE (optional text for the body)
#
# The release body carries the machine-readable `t3mesh-*` lines that later
# runs read: the highest published versionCode, the commit, the toolchain set
# and the target SDK. The tag is v<versionName>, created on COMMIT by the API.
# The asset name replaces `+` with `-` so no tool has to encode it.
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

apk="${1:?apk}"
require_match "commit" "$RE_SHA" "${COMMIT:?}"
require_match "versionName" "$RE_VERSION_NAME" "${VERSION_NAME:?}"
require_version_code "versionCode" "${VERSION_CODE:?}"
require_match "base tag" "$RE_NIGHTLY_TAG" "${BASE_TAG:?}"
require_match "toolchain id" "$RE_TOOLCHAIN_ID" "${TOOLCHAIN_ID:?}"
require_match "target SDK" '^[0-9]{1,3}$' "${TARGET_SDK:?}"
require_match "certificate digest" "$RE_SHA256" "${CERT_SHA256:?}"
[[ ${PRERELEASE:?} == true || $PRERELEASE == false ]] || die "PRERELEASE must be true or false"

tag="v$VERSION_NAME"
asset="t3-mesh-${VERSION_NAME//+/-}.apk"
if gh api "repos/${GH_REPO:?}/git/ref/tags/${tag//+/%2B}" >/dev/null 2>&1; then
  die "tag $tag already exists"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$apk" "$work/$asset"
{
  echo "Signed build of $COMMIT on upstream $BASE_TAG."
  echo
  if [[ -n ${HOLD_NOTE:-} ]]; then
    echo "$HOLD_NOTE"
    echo
  fi
  echo "t3mesh-commit: $COMMIT"
  echo "t3mesh-base: $BASE_TAG"
  echo "t3mesh-version-code: $VERSION_CODE"
  echo "t3mesh-target-sdk: $TARGET_SDK"
  echo "t3mesh-toolchain: $TOOLCHAIN_ID"
  echo "t3mesh-cert-sha256: $CERT_SHA256"
} >"$work/body.md"

args=("$tag" "$work/$asset" --repo "$GH_REPO" --target "$COMMIT" --title "$VERSION_NAME" --notes-file "$work/body.md")
if [[ $PRERELEASE == true ]]; then
  args+=(--prerelease)
fi
gh release create "${args[@]}"
