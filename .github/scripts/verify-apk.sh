#!/usr/bin/env bash
# Inspect an APK with the pinned tools and check it against what the build
# claimed and what the fork requires.
#
# usage: verify-apk.sh <apk>
# env:   BUILD_TOOLS_DIR
#        EXPECTED_VERSION_NAME EXPECTED_VERSION_CODE   (already validated)
#        EXPECTED_CERT_SHA256   when set, the APK must be signed and match it
# Prints application_id, version_code, version_name, target_sdk and, when
# checked, cert_sha256.
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

apk="${1:?apk}"
tools="${BUILD_TOOLS_DIR:?}"
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
"$here/apk-checks.sh" manifest "$work/manifest.txt" >/dev/null
echo "$badging"

if [[ -n ${EXPECTED_CERT_SHA256:-} ]]; then
  expected="$(tr -d ':' <<<"$EXPECTED_CERT_SHA256" | tr '[:upper:]' '[:lower:]')"
  require_match "expected certificate fingerprint" "$RE_SHA256" "$expected"
  java -jar "$tools/lib/apksigner.jar" verify --verbose --print-certs "$apk" >"$work/certs.txt"
  cert="$("$here/apk-checks.sh" certs "$work/certs.txt")"
  [[ "${cert#cert_sha256=}" == "$expected" ]] || die "signing certificate is not the expected one"
  echo "$cert"
fi
