#!/usr/bin/env bash
# Inspect an APK with the pinned tools and check it against what the build
# claimed and what the fork requires.
#
# usage: verify-apk.sh <apk> [--signed]
# env:   BUILD_TOOLS_DIR
#        EXPECTED_VERSION_NAME EXPECTED_VERSION_CODE   (already validated)
# Prints application_id, version_code, version_name, target_sdk and, when
# checked, cert_sha256.
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

apk="${1:?apk}"
mode="${2:-}"
tools="${BUILD_TOOLS_DIR:?}"
[[ -z $mode || $mode == --signed ]] || die "unknown verification mode: $mode"
[[ -f $apk && ! -L $apk ]] || die "$apk is not a regular file"
size="$(stat -c %s "$apk")"
((size > 0 && size <= 400 * 1024 * 1024)) || die "APK size $size is outside the accepted range"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
"$tools/aapt2" dump badging "$apk" >"$work/badging.txt"
"$tools/aapt2" dump xmltree --file AndroidManifest.xml "$apk" >"$work/manifest.txt"

badging="$("$here/apk-checks.sh" badging "$work/badging.txt")"
get() { sed -n "s/^$1=//p" <<<"$badging"; }
[[ "$(get application_id)" == "${EXPECTED_APPLICATION_ID:-com.noqer.t3mesh}" ]] || die "applicationId is not ${EXPECTED_APPLICATION_ID:-com.noqer.t3mesh}"
[[ "$(get version_name)" == "${EXPECTED_VERSION_NAME:?}" ]] || die "APK versionName differs from the metadata"
[[ "$(get version_code)" == "${EXPECTED_VERSION_CODE:?}" ]] || die "APK versionCode differs from the metadata"
TARGET_SDK="$(get target_sdk)" "$here/apk-checks.sh" manifest "$work/manifest.txt" >/dev/null
echo "$badging"

if [[ $mode == --signed ]]; then
  apksigner=(java -jar "$tools/lib/apksigner.jar")
  "${apksigner[@]}" verify --verbose --print-certs "$apk" >"$work/certs.txt"
  grep -Fxq 'Verified using v3 scheme (APK Signature Scheme v3): true' "$work/certs.txt" ||
    die "APK did not verify with the v3 signing scheme"
  cert="$("$here/apk-checks.sh" certs "$work/certs.txt")"
  "${apksigner[@]}" lineage --in "$here/../signing/t3mesh.lineage" --print-certs --verbose >"$work/expected.txt"
  "${apksigner[@]}" lineage --in "$apk" --print-certs --verbose >"$work/actual.txt"
  cmp -s "$work/expected.txt" "$work/actual.txt" || die "APK signing lineage differs from the release lineage"
  expected="$(sed -nE 's/^Signer #[0-9]+ in lineage certificate SHA-256 digest: //p' "$work/expected.txt" | tail -n 1)"
  [[ "${cert#cert_sha256=}" == "$expected" ]] || die "APK signing certificate is not the latest in the release lineage"
  echo "$cert"
fi
