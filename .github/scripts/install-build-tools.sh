#!/usr/bin/env bash
# Install the pinned Android build tools into a fresh directory and verify them.
#
# usage: install-build-tools.sh <sdk root>
# env:   ANDROID_CMDLINE_TOOLS_VERSION  zip number, e.g. 11076708
#        ANDROID_CMDLINE_TOOLS_SHA256   pinned digest of that zip
#        ANDROID_BUILD_TOOLS_VERSION    e.g. 36.0.0
#        APKSIGNER_JAR_SHA256 ZIPALIGN_SHA256 AAPT2_SHA256
#
# Integrity: the cmdline-tools zip must match the digest pinned on main;
# sdkmanager then verifies the build-tools package against the checksum in
# Google's repository index (served over HTTPS); finally the three binaries the
# release job relies on must match digests pinned on main.
# Prints build_tools_dir=<path> on success. Needs a JDK on PATH.
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

root="${1:?sdk root}"
cmdline_version="${ANDROID_CMDLINE_TOOLS_VERSION:?}"
cmdline_sha="${ANDROID_CMDLINE_TOOLS_SHA256:?}"
bt_version="${ANDROID_BUILD_TOOLS_VERSION:?}"
require_match "cmdline-tools version" '^[0-9]+$' "$cmdline_version"
require_match "build-tools version" '^[0-9]+\.[0-9]+\.[0-9]+$' "$bt_version"
require_match "cmdline-tools digest" "$RE_SHA256" "$cmdline_sha"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
zip="$work/cmdline-tools.zip"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "$zip" "https://dl.google.com/android/repository/commandlinetools-linux-${cmdline_version}_latest.zip"
echo "$cmdline_sha  $zip" | sha256sum --check --status || die "cmdline-tools zip does not match the pinned digest"

mkdir -p "$root/cmdline-tools"
unzip -q "$zip" -d "$work/unpacked"
mv "$work/unpacked/cmdline-tools" "$root/cmdline-tools/latest"

sdkmanager="$root/cmdline-tools/latest/bin/sdkmanager"
# `yes` ends with SIGPIPE once sdkmanager stops reading; that is expected.
{ yes || true; } | "$sdkmanager" --sdk_root="$root" --licenses >/dev/null
"$sdkmanager" --sdk_root="$root" "build-tools;$bt_version" >/dev/null

dir="$root/build-tools/$bt_version"
check() {
  local file="$1" want="$2"
  [[ -f $file && ! -L $file ]] || die "$file is missing"
  echo "$want  $file" | sha256sum --check --status || die "$(basename "$file") does not match the pinned digest"
}
check "$dir/lib/apksigner.jar" "${APKSIGNER_JAR_SHA256:?}"
check "$dir/zipalign" "${ZIPALIGN_SHA256:?}"
check "$dir/aapt2" "${AAPT2_SHA256:?}"
echo "build_tools_dir=$dir"
