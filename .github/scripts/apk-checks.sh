#!/usr/bin/env bash
# Parse and check the text output of the pinned Android tools. The release job
# runs the tools on the hostile APK and feeds their output here; nothing is
# read from the APK any other way.
#
# usage: apk-checks.sh badging  <aapt2 dump badging output>
#        apk-checks.sh manifest <aapt2 dump xmltree --file AndroidManifest.xml output>
#        apk-checks.sh certs    <apksigner verify --print-certs -v output>
#
# badging  prints application_id, version_code, version_name, target_sdk
# manifest prints "manifest ok" or fails listing every violation
# certs    prints cert_sha256 (lowercase hex) for the single signer
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

APPLICATION_ID="${EXPECTED_APPLICATION_ID:-com.noqer.t3mesh}"
URL_SCHEME="${EXPECTED_URL_SCHEME:-t3mesh}"
DEV_CLIENT_SCHEME="exp+t3-mesh"
FORBIDDEN_HOST="${FORBIDDEN_HOST:-app.t3.codes}"

cmd="${1:?subcommand}"
file="${2:?input file}"
[[ -f $file ]] || die "$file does not exist"

badging() {
  local pkg_lines package_line
  pkg_lines="$(grep -c '^package: ' "$file" || true)"
  [[ $pkg_lines == 1 ]] || die "badging has $pkg_lines package lines, expected 1"
  package_line="$(grep '^package: ' "$file")"
  local re="^package: name='([^']*)' versionCode='([^']*)' versionName='([^']*)'"
  [[ $package_line =~ $re ]] || die "badging package line is malformed"
  local id="${BASH_REMATCH[1]}" code="${BASH_REMATCH[2]}" name="${BASH_REMATCH[3]}"
  [[ $id =~ ^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$ ]] || die "application id has an unexpected format"
  require_version_code "APK versionCode" "$code"
  require_match "APK versionName" "$RE_VERSION_NAME" "$name"
  local target_lines target
  target_lines="$(grep -c '^targetSdkVersion:' "$file" || true)"
  [[ $target_lines == 1 ]] || die "badging has $target_lines targetSdkVersion lines, expected 1"
  target="$(sed -n "s/^targetSdkVersion:'\([0-9]\{1,3\}\)'\$/\1/p" "$file")"
  [[ -n $target ]] || die "targetSdkVersion is malformed"
  printf 'application_id=%s\nversion_code=%s\nversion_name=%s\ntarget_sdk=%s\n' "$id" "$code" "$name" "$target"
}

# Flatten xmltree output to one line per element:
#   <id> TAB <path> TAB <attr>=<value> TAB ...
# Attribute names lose the android namespace URI and resource id suffix.
flatten_xmltree() {
  awk '
    function finish() { if (id > 0) print out }
    /^[ ]*E: / {
      finish()
      ind = match($0, /E: /) - 1
      name = $0; sub(/^[ ]*E: /, "", name); sub(/ \(line=.*$/, "", name)
      while (n > 0 && indent[n] >= ind) n--
      n++; indent[n] = ind; names[n] = name
      path = ""; for (i = 1; i <= n; i++) path = path "/" names[i]
      id++; out = id "\t" path
      next
    }
    /^[ ]*A: / {
      line = $0; sub(/^[ ]*A: /, "", line)
      eq = index(line, "="); an = substr(line, 1, eq - 1); rest = substr(line, eq + 1)
      sub(/^http:\/\/schemas\.android\.com\/apk\/res\/android:/, "android:", an)
      sub(/\(0x[0-9a-f]+\)$/, "", an)
      if (substr(rest, 1, 1) == "\"") { match(rest, /^"[^"]*"/); v = substr(rest, 2, RLENGTH - 2) }
      else if (rest ~ /^\(type 0x12\)/) { v = (substr(rest, 12) ~ /^0x0( |$)/) ? "false" : "true" }
      else { split(rest, p, " "); v = p[1] }
      out = out "\t" an "=" v
      next
    }
    END { finish() }
  ' "$file"
}

# elem_has <flat> <path> <attr=value>...: some element at <path> has all the attributes.
elem_has() {
  local flat="$1" path="$2"
  shift 2
  awk -F'\t' -v path="$path" -v want="$(printf '%s\t' "$@")" '
    BEGIN { n = split(want, w, "\t"); n-- }
    $2 == path {
      ok = 1
      for (k = 1; k <= n; k++) {
        hit = 0
        for (i = 3; i <= NF; i++) if ($i == w[k]) hit = 1
        if (!hit) ok = 0
      }
      if (ok) found = 1
    }
    END { exit !found }
  ' <<<"$flat"
}

manifest() {
  local flat failures=()
  flat="$(flatten_xmltree)"
  [[ -n $flat ]] || die "manifest dump is empty or unparsable"

  elem_has "$flat" /manifest "package=$APPLICATION_ID" ||
    failures+=("manifest package is not $APPLICATION_ID")
  elem_has "$flat" /manifest/application/meta-data \
    "android:name=expo.modules.updates.ENABLED" "android:value=false" ||
    failures+=("expo.modules.updates.ENABLED is not explicitly false")

  if grep -qF -- "$FORBIDDEN_HOST" <<<"$flat"; then
    failures+=("manifest mentions $FORBIDDEN_HOST")
  fi
  if grep -qP '\tandroid:autoVerify=(?!false(\t|$))' <<<"$flat"; then
    failures+=("an intent filter sets autoVerify")
  fi

  # Android 17 gates LAN access behind ACCESS_LOCAL_NETWORK for apps targeting 37+, and
  # declaring it below 37 withdraws the implicit grant: either mismatch breaks LAN access.
  if [[ -n ${TARGET_SDK:-} ]]; then
    local local_network=false
    if grep -qP '^\d+\t/manifest/uses-permission\t.*\tandroid:name=android\.permission\.ACCESS_LOCAL_NETWORK(\t|$)' <<<"$flat"; then
      local_network=true
    fi
    if ((TARGET_SDK >= 37)) && ! $local_network; then
      failures+=("targetSdkVersion $TARGET_SDK needs uses-permission ACCESS_LOCAL_NETWORK")
    elif ((TARGET_SDK < 37)) && $local_network; then
      failures+=("ACCESS_LOCAL_NETWORK is declared below targetSdkVersion 37, which withdraws LAN access on Android 17")
    fi
  fi

  local data_lines schemes=0 line scheme host
  data_lines="$(grep -P '^\d+\t/manifest/application/[^\t]*intent-filter/data\t' <<<"$flat" || true)"
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    scheme="$(grep -oP '\tandroid:scheme=\K[^\t]*' <<<"$line" || true)"
    if [[ -n $scheme ]]; then
      host="$(grep -oP '\tandroid:host=\K[^\t]*' <<<"$line" || true)"
      if [[ $scheme == "$URL_SCHEME" ]]; then
        schemes=$((schemes + 1))
      elif [[ $scheme == "$DEV_CLIENT_SCHEME" ]]; then
        : # expo-dev-client registers exp+<slug>; the slug is the fork's own.
      elif [[ $scheme == clerk && $host == "$APPLICATION_ID".* ]]; then
        : # The Clerk SDK's own manifest registers clerk://<applicationId>.<path> callbacks.
      else
        failures+=("intent filter data uses scheme '$scheme', only '$URL_SCHEME' is allowed")
      fi
    fi
  done <<<"$data_lines"
  ((schemes > 0)) || failures+=("no intent filter declares the $URL_SCHEME scheme")

  if ((${#failures[@]} > 0)); then
    printf '::error::%s\n' "${failures[@]}" >&2
    exit 1
  fi
  echo "manifest ok"
}

certs() {
  grep -q '^Verifies$' "$file" || die "apksigner did not report Verifies"
  grep -qE '^Verified using v[23] scheme .*: true$' "$file" || die "APK is not verified with the v2 or v3 scheme"
  grep -qx 'Number of signers: 1' "$file" || die "APK must have exactly one signer"
  # apksigner labels signers "Signer #1" or, for v3 signing, "V3.0 Signer".
  local prefix='^(Signer #[0-9]+|V[0-9.]+ Signer):? certificate SHA-256 digest: ' digests digest
  digests="$(grep -E "$prefix" "$file" | sed -E "s/$prefix//" | sort -u)"
  [[ -n $digests && $digests != *$'\n'* ]] || die "expected exactly one signer digest"
  digest="$digests"
  [[ $digest =~ ^[0-9a-f]{64}$ ]] || die "signer digest is malformed"
  echo "cert_sha256=$digest"
}

case "$cmd" in
badging) badging ;;
manifest) manifest ;;
certs) certs ;;
*) die "unknown subcommand $cmd" ;;
esac
