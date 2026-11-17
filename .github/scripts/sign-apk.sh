#!/usr/bin/env bash
# Align and sign an APK with the pinned build tools.
#
# usage: sign-apk.sh <unsigned apk> <signed apk>
# env:   BUILD_TOOLS_DIR
#        SIGNING_KEYSTORE_B64 SIGNING_KEYSTORE_PASSWORD SIGNING_KEY_ALIAS SIGNING_KEY_PASSWORD
#
# Secrets reach apksigner through environment variables, never the command
# line, and the keystore exists only in a private temporary directory.
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

in="${1:?unsigned apk}"
out="${2:?signed apk}"
tools="${BUILD_TOOLS_DIR:?}"
: "${SIGNING_KEYSTORE_B64:?}" "${SIGNING_KEYSTORE_PASSWORD:?}" "${SIGNING_KEY_ALIAS:?}" "${SIGNING_KEY_PASSWORD:?}"
[[ $SIGNING_KEY_ALIAS != *$'\n'* ]] || die "signing key alias is malformed"
[[ -f $in && ! -L $in ]] || die "$in is not a regular file"

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
base64 --decode <<<"$SIGNING_KEYSTORE_B64" >"$work/keystore.jks" || die "keystore secret is not valid base64"

"$tools/zipalign" -f -p 4 "$in" "$work/aligned.apk"
java -jar "$tools/lib/apksigner.jar" sign \
  --ks "$work/keystore.jks" \
  --ks-key-alias "$SIGNING_KEY_ALIAS" \
  --ks-pass env:SIGNING_KEYSTORE_PASSWORD \
  --key-pass env:SIGNING_KEY_PASSWORD \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true \
  --out "$out" "$work/aligned.apk"
