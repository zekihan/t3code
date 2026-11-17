#!/usr/bin/env bash
# Local test harness for the scripts: bash .github/scripts/test/run.sh
# shellcheck disable=SC2015,SC2030,SC2031,SC2016
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
T="$PWD"
S="$T/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL: $1"; [[ -n ${2:-} ]] && printf '%s\n' "${2//$'\n'/$'\n'    }" | sed 's/^/    /'; }

# expect_ok <name> <cmd...> : exit 0.  expect_fail <name> <pattern> <cmd...> : non-zero and output matches.
expect_ok() {
  local name="$1" out
  shift
  if out="$("$@" 2>&1)"; then ok; else bad "$name" "$out"; fi
}
expect_fail() {
  local name="$1" pattern="$2" out
  shift 2
  if out="$("$@" 2>&1)"; then bad "$name (expected failure)" "$out"; elif grep -qE -- "$pattern" <<<"$out"; then ok; else bad "$name (wrong error)" "$out"; fi
}
expect_out() {
  local name="$1" want="$2" out
  shift 2
  out="$("$@" 2>/dev/null)" || { bad "$name (failed)" "$("$@" 2>&1)"; return; }
  if [[ $out == "$want" ]]; then ok; else bad "$name" "want: $want"$'\n'"got:  $out"; fi
}

# ---- base-tag ---------------------------------------------------------------
repo="$tmp/repo"
git init -q "$repo"
(
  cd "$repo" || exit 1
  git config user.email t@t
  git config user.name t
  c() { git commit -q --allow-empty -m "$1"; }
  c a
  git update-ref refs/upstream-tags/v0.1.11-nightly.20261117.4814 HEAD
  c b
  git update-ref refs/upstream-tags/v0.1.11-nightly.20261117.4825 HEAD
  git update-ref refs/upstream-tags/v0.1.11-preview.20261117.4830 HEAD
  git branch other
  c s1
  git update-ref refs/tags/stack1 HEAD
  c s2
  git update-ref refs/tags/stack2 HEAD
  git checkout -q other
  c unrelated
  git update-ref refs/upstream-tags/v0.1.11-nightly.20261118.4900 HEAD
  git update-ref refs/tags/unrelated HEAD
  git checkout -q stack2 2>/dev/null
  git checkout -q -b merged
  git merge -q --no-ff -m merge unrelated
  git update-ref refs/tags/merged HEAD
  git update-ref refs/tags/orphan "$(git commit-tree -m orphan "$(git hash-object -t tree /dev/null)")"
)
cd "$repo" || exit 1
expect_out "base-tag picks the newest ancestor nightly" "v0.1.11-nightly.20261117.4825" "$S/base-tag.sh" stack2
expect_out "base-tag ignores preview and non-ancestor tags" "v0.1.11-nightly.20261117.4825" "$S/base-tag.sh" stack1
expect_fail "base-tag rejects a merge in the stack" "merge commit" "$S/base-tag.sh" merged
expect_fail "base-tag rejects the tag commit itself" "not a stack" "$S/base-tag.sh" 'refs/upstream-tags/v0.1.11-nightly.20261117.4825'
expect_fail "base-tag rejects an oversize stack" "limit 1" env MAX_STACK=1 "$S/base-tag.sh" stack2
expect_fail "base-tag rejects a commit with no nightly ancestor" "no upstream nightly" "$S/base-tag.sh" orphan
cd "$T" || exit 1

# ---- fetch-upstream-tags ------------------------------------------------------
up="$tmp/upstream"
git init -q "$up"
(
  cd "$up" || exit 1
  git config user.email t@t
  git config user.name t
  git config tag.gpgSign false
  git commit -q --allow-empty -m one
  git tag v0.2.0-nightly.20261201.10
  git commit -q --allow-empty -m two
  git tag -a -m annotated v0.2.0-nightly.20261201.11
  git tag v0.2.0-preview.20261201.12
  git tag v0.2.0-nightly.garbage
  git commit -q --allow-empty -m three
  git tag v0.2.0-nightly.20261201.13
)
git clone -q --no-tags "$up" "$tmp/forkclone"
git -C "$tmp/forkclone" reset -q --hard HEAD~1
git -C "$tmp/forkclone" gc -q --prune=now 2>/dev/null
cd "$tmp/forkclone" || exit 1
git update-ref -d refs/remotes/origin/master 2>/dev/null; git update-ref -d refs/remotes/origin/main 2>/dev/null
git reflog expire --expire=now --all; git gc -q --prune=now
expect_ok "upstream-tags: records nightly tags" "$S/fetch-upstream-tags.sh" "$up"
expect_out "upstream-tags: keeps only nightlies present locally, peels annotated" \
  $'refs/upstream-tags/v0.2.0-nightly.20261201.10\nrefs/upstream-tags/v0.2.0-nightly.20261201.11' \
  git for-each-ref --format='%(refname)' refs/upstream-tags
expect_fail "upstream-tags: unreachable upstream" "ls-remote|does not appear|fatal" "$S/fetch-upstream-tags.sh" "$tmp/nonexistent"
cd "$T" || exit 1

# ---- compute-version --------------------------------------------------------
rel="$tmp/releases.ndjson"
: >"$rel"
expect_out "version: first release of a nightly" $'version_name=0.1.11-nightly.20261117.4838+mesh.1\nversion_code=483801\nhighest_code=0' \
  "$S/compute-version.sh" release v0.1.11-nightly.20261117.4838 "$rel"

cat >"$rel" <<'J'
{"tag_name":"v0.1.11-nightly.20261117.4838+mesh.1","prerelease":false,"body":"x\nt3mesh-version-code: 483801\nt3mesh-target-sdk: 36","target_commitish":"a"}
{"tag_name":"v0.1.11-nightly.20261117.4838+mesh.2","prerelease":true,"body":"t3mesh-version-code: 483802","target_commitish":"b"}
{"tag_name":"v0.1.11-nightly.20261117.4825+mesh.3","prerelease":false,"body":"t3mesh-version-code: 482503","target_commitish":"c"}
{"tag_name":"v0.1.11-nightly.20261117.4825+mesh.3.rollback","prerelease":false,"body":"t3mesh-version-code: 483803","target_commitish":"c"}
{"tag_name":"v0.0.1","prerelease":false,"body":"hand made","target_commitish":"d"}
J
expect_out "version: pre-releases count toward rev" $'version_name=0.1.11-nightly.20261117.4838+mesh.3\nversion_code=483804\nhighest_code=483803' \
  "$S/compute-version.sh" release v0.1.11-nightly.20261117.4838 "$rel"
expect_out "version: rev restarts on a new base, code stays above the highest" $'version_name=0.1.12-nightly.20261118.4000+mesh.1\nversion_code=483804\nhighest_code=483803' \
  "$S/compute-version.sh" release v0.1.12-nightly.20261118.4000 "$rel"
expect_out "version: rollback" $'version_name=0.1.11-nightly.20261117.4838+mesh.1.rollback\nversion_code=483804\nhighest_code=483803' \
  "$S/compute-version.sh" rollback v0.1.11-nightly.20261117.4838 "$rel" 0.1.11-nightly.20261117.4838+mesh.1
expect_out "version: second rollback of the same release" $'version_name=0.1.11-nightly.20261117.4825+mesh.3.rollback.2\nversion_code=483804\nhighest_code=483803' \
  "$S/compute-version.sh" rollback v0.1.11-nightly.20261117.4825 "$rel" 0.1.11-nightly.20261117.4825+mesh.3
expect_fail "version: rollback must match its base" "does not belong" "$S/compute-version.sh" rollback v0.1.11-nightly.20261117.4838 "$rel" 0.1.11-nightly.20261117.4825+mesh.3
expect_fail "version: rollback of a rollback is refused" "unexpected format" "$S/compute-version.sh" rollback v0.1.11-nightly.20261117.4825 "$rel" 0.1.11-nightly.20261117.4825+mesh.3.rollback
expect_fail "version: bad base tag" "unexpected format" "$S/compute-version.sh" release v0.1.11-preview.20261117.4838 "$rel"
jq -nc '{tag_name:"v0.1.11-nightly.20261117.4838+mesh.99",prerelease:false,body:"t3mesh-version-code: 483899"}' >"$rel"
expect_fail "version: rev above 99" "outside 1..99" "$S/compute-version.sh" release v0.1.11-nightly.20261117.4838 "$rel"
jq -nc '{tag_name:"v0.1.0",prerelease:false,body:"t3mesh-version-code: 2100000000"}' >"$rel"
expect_fail "version: no room under the Android limit" "leaves no room" "$S/compute-version.sh" release v0.1.11-nightly.20261117.4838 "$rel"

# ---- metadata ---------------------------------------------------------------
meta="$tmp/meta.json"
COMMIT=$(printf 'a%.0s' {1..40}) VERSION_NAME=0.1.11-nightly.20261117.4838+mesh.1 VERSION_CODE=483801 \
  BASE_TAG=v0.1.11-nightly.20261117.4838 TOOLCHAIN_ID=test-1 "$S/write-metadata.sh" "$meta"
expect_out "metadata: valid" $'commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nversion_name=0.1.11-nightly.20261117.4838+mesh.1\nversion_code=483801\nbase_tag=v0.1.11-nightly.20261117.4838\ntoolchain=test-1' \
  "$S/validate-metadata.sh" "$meta"
mutate() { jq -c "$1" "$meta" >"$tmp/m.json"; }
mutate '.versionName = "1.0+mesh.1\nINJECT"'; expect_fail "metadata: newline in versionName" "versionName" "$S/validate-metadata.sh" "$tmp/m.json"
mutate '.versionCode = "0123"'; expect_fail "metadata: leading zero code" "versionCode" "$S/validate-metadata.sh" "$tmp/m.json"
mutate '.versionCode = "2100000001"'; expect_fail "metadata: code too large" "exceeds" "$S/validate-metadata.sh" "$tmp/m.json"
mutate '.commit = "main"'; expect_fail "metadata: commit not a sha" "commit" "$S/validate-metadata.sh" "$tmp/m.json"
mutate '.baseTag = "v0.1.10-nightly.20261117.4838"'; expect_fail "metadata: name/base mismatch" "base tag" "$S/validate-metadata.sh" "$tmp/m.json"
mutate '.extra = "x"'; expect_fail "metadata: extra field" "exactly five" "$S/validate-metadata.sh" "$tmp/m.json"
mutate '.versionCode = 483801'; expect_fail "metadata: non-string field" "exactly five" "$S/validate-metadata.sh" "$tmp/m.json"
mutate '.toolchain = "../x"'; expect_fail "metadata: toolchain traversal" "toolchain" "$S/validate-metadata.sh" "$tmp/m.json"
echo '[]' >"$tmp/m.json"; expect_fail "metadata: not an object" "exactly five" "$S/validate-metadata.sh" "$tmp/m.json"
head -c 5000 /dev/zero | tr '\0' ' ' >"$tmp/m.json"; expect_fail "metadata: too large" "4 KiB" "$S/validate-metadata.sh" "$tmp/m.json"

# ---- toolchain --------------------------------------------------------------
tc="$tmp/tc"
mkdir -p "$tc/sets"
cp fixtures/toolchain-good.env "$tc/sets/test-1.env"
echo "test-1" >"$tc/current"
expect_ok "toolchain: loads current" "$S/load-toolchain.sh" "$tc"
expect_out "toolchain: lowercases keys" "java_version=17" bash -c "'$S/load-toolchain.sh' '$tc' test-1 | grep '^java_version='"
sed 's/^JAVA_VERSION=17/JAVA_VERSION=TODO/' fixtures/toolchain-good.env >"$tc/sets/test-2.env"; sed -i 's/test-1/test-2/' "$tc/sets/test-2.env"
expect_fail "toolchain: TODO value" "still TODO" "$S/load-toolchain.sh" "$tc" test-2
sed 's/^NODE_VERSION.*//; s/test-1/test-3/' fixtures/toolchain-good.env >"$tc/sets/test-3.env"
expect_fail "toolchain: missing key" "NODE_VERSION is missing" "$S/load-toolchain.sh" "$tc" test-3
{ sed 's/test-1/test-4/' fixtures/toolchain-good.env; echo 'EVIL=1'; } >"$tc/sets/test-4.env"
expect_fail "toolchain: unknown key" "unknown key" "$S/load-toolchain.sh" "$tc" test-4
{ sed 's/test-1/test-5/' fixtures/toolchain-good.env; echo 'NODE_VERSION=$(id)'; } >"$tc/sets/test-5.env"
expect_fail "toolchain: shell metacharacters" "malformed" "$S/load-toolchain.sh" "$tc" test-5
cp fixtures/toolchain-good.env "$tc/sets/test-6.env"
expect_fail "toolchain: id differs from file name" "does not match the file name" "$S/load-toolchain.sh" "$tc" test-6
expect_fail "toolchain: unknown set" "does not exist" "$S/load-toolchain.sh" "$tc" nope
expect_fail "toolchain: traversal id" "unexpected format" "$S/load-toolchain.sh" "$tc" ../x

# ---- apk-checks -------------------------------------------------------------
expect_out "badging: fields" $'application_id=com.noqer.t3mesh\nversion_code=481401\nversion_name=0.1.11-nightly.20261117.4814+mesh.1\ntarget_sdk=36' \
  "$S/apk-checks.sh" badging fixtures/badging.txt
sed "s/versionName='[^']*'/versionName='x y'/" fixtures/badging.txt >"$tmp/b.txt"
expect_fail "badging: bad versionName" "versionName" "$S/apk-checks.sh" badging "$tmp/b.txt"
{ cat fixtures/badging.txt; echo "package: name='evil.app' versionCode='1' versionName='1'"; } >"$tmp/b.txt"
expect_fail "badging: duplicate package line" "expected 1" "$S/apk-checks.sh" badging "$tmp/b.txt"
expect_out "manifest: good" "manifest ok" "$S/apk-checks.sh" manifest fixtures/manifest-good.txt
m="$tmp/mf.txt"
sed 's/expo.modules.updates.ENABLED/expo.modules.updates.OTHER/' fixtures/manifest-good.txt >"$m"
expect_fail "manifest: updates flag missing" "ENABLED is not explicitly false" "$S/apk-checks.sh" manifest "$m"
sed '0,/value(0x01010024)=false/s//value(0x01010024)=true/' fixtures/manifest-good.txt >"$m"
expect_fail "manifest: updates enabled" "ENABLED is not explicitly false" "$S/apk-checks.sh" manifest "$m"
sed '0,/value(0x01010024)=false/s//value(0x01010024)=(type 0x12)0x0/' fixtures/manifest-good.txt >"$m"
expect_ok "manifest: boolean printed as typed value" "$S/apk-checks.sh" manifest "$m"
sed 's/package="com.noqer.t3mesh" (Raw: "com.noqer.t3mesh")/package="com.t3tools.t3code" (Raw: "x")/' fixtures/manifest-good.txt >"$m"
expect_fail "manifest: wrong package" "package is not" "$S/apk-checks.sh" manifest "$m"
sed 's/"t3mesh" (Raw: "t3mesh")/"https" (Raw: "https")/' fixtures/manifest-good.txt >"$m"
expect_fail "manifest: https scheme" "scheme 'https'" "$S/apk-checks.sh" manifest "$m"
sed 's/^\(      *\)A: http:\/\/schemas.android.com\/apk\/res\/android:scheme.*/&\n\1A: http:\/\/schemas.android.com\/apk\/res\/android:host(0x01010028)="app.t3.codes" (Raw: "app.t3.codes")/' fixtures/manifest-good.txt >"$m"
expect_fail "manifest: app.t3.codes host" "app.t3.codes" "$S/apk-checks.sh" manifest "$m"
sed 's/^\( *\)E: intent-filter (line=28)/&\n\1  A: http:\/\/schemas.android.com\/apk\/res\/android:autoVerify(0x010104ee)=true/' fixtures/manifest-good.txt >"$m"
expect_fail "manifest: autoVerify" "autoVerify" "$S/apk-checks.sh" manifest "$m"
grep -v 'scheme(0x' fixtures/manifest-good.txt >"$m"
expect_fail "manifest: no t3mesh scheme" "declares the t3mesh scheme" "$S/apk-checks.sh" manifest "$m"
: >"$m"
expect_fail "manifest: empty" "empty" "$S/apk-checks.sh" manifest "$m"
expect_out "certs: single signer" "cert_sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" "$S/apk-checks.sh" certs fixtures/certs-good.txt
sed 's/^Number of signers: 1/Number of signers: 2/' fixtures/certs-good.txt >"$tmp/c.txt"
expect_fail "certs: two signers" "exactly one signer" "$S/apk-checks.sh" certs "$tmp/c.txt"
sed 's/scheme (APK Signature Scheme v[23]): true/scheme: false/' fixtures/certs-good.txt >"$tmp/c.txt"
expect_fail "certs: no v2/v3" "v2 or v3" "$S/apk-checks.sh" certs "$tmp/c.txt"
{ cat fixtures/certs-good.txt; echo "Signer #2 certificate SHA-256 digest: ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"; } >"$tmp/c.txt"
expect_fail "certs: second digest" "exactly one signer digest" "$S/apk-checks.sh" certs "$tmp/c.txt"

# ---- verify-apk with stub tools --------------------------------------------
bt="$tmp/bt"
mkdir -p "$bt/lib"
cat >"$bt/aapt2" <<STUB
#!/usr/bin/env bash
if [[ \$2 == badging ]]; then cat "$T/fixtures/badging.txt"; else cat "${MANIFEST_FIXTURE:-$T/fixtures/manifest-good.txt}"; fi
STUB
cat >"$bt/java" <<STUB
#!/usr/bin/env bash
cat "$T/fixtures/certs-good.txt"
STUB
chmod +x "$bt/aapt2" "$bt/java"
echo apk >"$tmp/app.apk"
export BUILD_TOOLS_DIR="$bt" EXPECTED_VERSION_NAME="0.1.11-nightly.20261117.4814+mesh.1" EXPECTED_VERSION_CODE=481401
expect_ok "verify-apk: unsigned checks" "$S/verify-apk.sh" "$tmp/app.apk"
(
  PATH="$bt:$PATH"
  EXPECTED_CERT_SHA256=01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF "$S/verify-apk.sh" "$tmp/app.apk"
) >/dev/null 2>&1 && ok || bad "verify-apk: matching certificate"
(
  PATH="$bt:$PATH"
  EXPECTED_CERT_SHA256=$(printf 'f%.0s' {1..64}) "$S/verify-apk.sh" "$tmp/app.apk"
) >"$tmp/o.txt" 2>&1 && bad "verify-apk: wrong certificate accepted" || { grep -q "not the expected" "$tmp/o.txt" && ok || bad "verify-apk: wrong certificate message" "$(cat "$tmp/o.txt")"; }
expect_fail "verify-apk: versionCode mismatch" "versionCode differs" env EXPECTED_VERSION_CODE=1 "$S/verify-apk.sh" "$tmp/app.apk"
expect_fail "verify-apk: versionName mismatch" "versionName differs" env EXPECTED_VERSION_NAME=0.0.1-nightly.20260101.1+mesh.1 "$S/verify-apk.sh" "$tmp/app.apk"
expect_fail "verify-apk: applicationId mismatch" "applicationId" env EXPECTED_APPLICATION_ID=com.other.app "$S/verify-apk.sh" "$tmp/app.apk"
unset BUILD_TOOLS_DIR EXPECTED_VERSION_NAME EXPECTED_VERSION_CODE

# ---- release-info -----------------------------------------------------------
rel="$tmp/info.ndjson"
sha=$(printf 'b%.0s' {1..40})
jq -nc --arg sha "$sha" '{tag_name:"v0.1.11-nightly.20261117.4838+mesh.1",prerelease:false,body:("t\n\nt3mesh-commit: "+$sha+"\nt3mesh-base: v0.1.11-nightly.20261117.4838\nt3mesh-version-code: 483801\nt3mesh-target-sdk: 36\nt3mesh-toolchain: test-1\n")}' >"$rel"
jq -nc '{tag_name:"v0.1.11-nightly.20261118.4900+mesh.1",prerelease:true,body:"t3mesh-target-sdk: 37"}' | cat - "$rel" >"$tmp/info2.ndjson"
expect_out "release-info: show" $'commit='"$sha"$'\nversion_name=0.1.11-nightly.20261117.4838+mesh.1\ntoolchain=test-1\nbase_tag=v0.1.11-nightly.20261117.4838' \
  "$S/release-info.sh" show "$rel" "v0.1.11-nightly.20261117.4838+mesh.1"
expect_fail "release-info: unknown tag" "no release" "$S/release-info.sh" show "$rel" "v0.1.11-nightly.20261117.4838+mesh.9"
expect_fail "release-info: rollback tag refused" "unexpected format" "$S/release-info.sh" show "$rel" "v0.1.11-nightly.20261117.4838+mesh.1.rollback"
expect_fail "release-info: injection in tag" "unexpected format" "$S/release-info.sh" show "$rel" 'v1";rm -rf'
expect_out "release-info: target sdk skips pre-releases" "36" "$S/release-info.sh" target-sdk "$tmp/info2.ndjson"
expect_out "release-info: no stable release" "" "$S/release-info.sh" target-sdk /dev/null

# ---- gh stubs: daily-check and check-ref -----------------------------------
stub="$tmp/stub"
mkdir -p "$stub"
tip=$(printf 'c%.0s' {1..40})
cat >"$stub/gh" <<'STUB'
#!/usr/bin/env bash
echo "gh $*" >>"$STUB_LOG"
case "$*" in
  "api repos/r/git/ref/heads/candidate --jq .object.sha") echo "$STUB_TIP" ;;
  "api repos/r/compare/mesh...candidate --jq .status") echo "${STUB_STATUS:-ahead}" ;;
  pr\ list*) echo "${STUB_PRS:-0}" ;;
  "api --paginate repos/r/releases?per_page=100"*) printf '%s\n' "${STUB_RELEASES:-}" ;;
  run\ list*) echo "${STUB_RUNS:-[]}" ;;
  workflow\ run*) ;;
  "api repos/r/git/ref/"*) printf '%s\t%s\n' "${STUB_REF_TYPE:-commit}" "${STUB_REF_SHA:-$STUB_TIP}" ;;
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
STUB
chmod +x "$stub/gh"
export STUB_LOG="$tmp/gh.log" STUB_TIP="$tip" GH_REPO=r
run_daily() { : >"$STUB_LOG"; PATH="$stub:$PATH" "$S/daily-check.sh" 2>&1; }
out="$(run_daily)"; grep -q 'dispatching release.yml' <<<"$out" && grep -q "workflow run release.yml --repo r --ref main -f commit=$tip" "$STUB_LOG" && ok || bad "daily: dispatches" "$out"
out="$(STUB_STATUS=identical run_daily)"; grep -q 'nothing to build' <<<"$out" && ! grep -q 'workflow run' "$STUB_LOG" && ok || bad "daily: identical" "$out"
out="$(STUB_STATUS=behind run_daily)"; grep -q 'nothing to build' <<<"$out" && ! grep -q 'workflow run' "$STUB_LOG" && ok || bad "daily: behind" "$out"
out="$(STUB_STATUS=diverged run_daily)"; grep -q 'dispatching' <<<"$out" && ok || bad "daily: diverged (rebased stack)" "$out"
out="$(STUB_PRS=1 run_daily)"; grep -q 'open PR' <<<"$out" && ! grep -q 'workflow run' "$STUB_LOG" && ok || bad "daily: open PR" "$out"
out="$(STUB_RELEASES="{\"tag_name\":\"v1\",\"target_commitish\":\"$tip\",\"body\":\"\"}" run_daily)"; grep -q 'release already exists' <<<"$out" && ! grep -q 'workflow run' "$STUB_LOG" && ok || bad "daily: release by target" "$out"
out="$(STUB_RELEASES="{\"tag_name\":\"v1\",\"target_commitish\":\"main\",\"body\":\"t3mesh-commit: $tip\"}" run_daily)"; grep -q 'release already exists' <<<"$out" && ok || bad "daily: release by body" "$out"
out="$(STUB_RELEASES='{"tag_name":"v1","target_commitish":"main","body":"t3mesh-commit: other"}' run_daily)"; grep -q 'dispatching' <<<"$out" && ok || bad "daily: other release does not block" "$out"
out="$(STUB_RUNS="[{\"status\":\"in_progress\",\"displayTitle\":\"Release $tip\"}]" run_daily)"; grep -q 'queued or running' <<<"$out" && ! grep -q 'workflow run' "$STUB_LOG" && ok || bad "daily: run in progress" "$out"
out="$(STUB_RUNS="[{\"status\":\"completed\",\"displayTitle\":\"Release $tip\"}]" run_daily)"; grep -q 'dispatching' <<<"$out" && ok || bad "daily: completed run does not block" "$out"
out="$(DRY_RUN=1 run_daily)"; grep -q 'would dispatch' <<<"$out" && ! grep -q 'workflow run' "$STUB_LOG" && ok || bad "daily: dry run" "$out"
expect_ok "check-ref: matches" env PATH="$stub:$PATH" "$S/check-ref.sh" heads/candidate "$tip"
expect_fail "check-ref: moved" "now points at" env PATH="$stub:$PATH" STUB_REF_SHA="$(printf 'd%.0s' {1..40})" "$S/check-ref.sh" heads/candidate "$tip"
expect_fail "check-ref: annotated tag" "plain commit ref" env PATH="$stub:$PATH" STUB_REF_TYPE=tag "$S/check-ref.sh" tags/v1 "$tip"

echo "passed: $pass failed: $fail"
((fail == 0))
