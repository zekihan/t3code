#!/usr/bin/env bash
# Tests for weekly.sh against throwaway repositories. `gh` is a PATH shim that
# records its calls; nothing touches a real remote.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WEEKLY=$HERE/weekly.sh
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/weekly-test.XXXXXX")
trap 'rm -rf "$ROOT"' EXIT

export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
unset GH_REPO

pass=0
fail=0
check() { # description, expected, actual
	if [ "$2" = "$3" ]; then
		pass=$((pass + 1))
	else
		fail=$((fail + 1))
		printf 'FAIL %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3"
	fi
}
check_true() { # description, command...
	local d=$1
	shift
	if "$@" >/dev/null 2>&1; then check "$d" ok ok; else check "$d" ok failed; fi
}

mkdir -p "$ROOT/bin"
cat >"$ROOT/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$GH_LOG"
case "$1 $2" in
"release list") cat "$GH_RELEASES" ;;
"pr list") cat "$GH_PRS" ;;
"workflow run") ;;
*) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$ROOT/bin/gh"
export PATH="$ROOT/bin:$PATH"

# Fresh world: W/up (upstream), W/origin.git, W/clone. The stack on nightly 4814
# is S1 (remove workflows), S2 (mtls), S3 (app identity), released as ...4814+mesh.1.
n=0
world() {
	n=$((n + 1))
	W=$ROOT/w$n
	mkdir -p "$W"
	export GH_LOG=$W/gh.log GH_RELEASES=$W/releases.json GH_PRS=$W/prs.json
	: >"$GH_LOG"
	echo '[]' >"$GH_PRS"

	git init -q -b main "$W/up"
	(
		cd "$W/up"
		mkdir -p .github/workflows apps/mobile src
		echo 'name: ci' >.github/workflows/ci.yml
		printf 'name=t3\nversion=1\n' >apps/mobile/app.config.ts
		echo base >src/other.txt
		git add -A && git commit -q -m 'Upstream base'
		git tag v0.1.11-nightly.20261117.4814
	)
	git init -q --bare -b main "$W/origin.git"
	git init -q -b main "$W/clone"
	(
		cd "$W/clone"
		git remote add origin "$W/origin.git"
		git remote add upstream "$W/up"
		git remote set-url --push upstream no-push
		echo fork >README.md && git add -A && git commit -q -m 'Fork main'
		git push -q origin main
		git fetch -q upstream --tags
		git checkout -q -b work v0.1.11-nightly.20261117.4814
		git rm -q -r .github/workflows && git commit -q -m 'Remove upstream workflows'
		mkdir -p modules && echo mtls >modules/mtls.txt
		git add -A && git commit -q -m 'Add mTLS'
		sed -i 's/name=t3/name=t3mesh/' apps/mobile/app.config.ts
		git commit -q -am 'App identity'
		git push -q origin work:mesh work:candidate
		git tag 'v0.1.11-nightly.20261117.4814+mesh.1'
		git push -q origin 'v0.1.11-nightly.20261117.4814+mesh.1'
		git checkout -q main
		git branch -q -D work
	)
	release 'v0.1.11-nightly.20261117.4814+mesh.1' false
}

# release TAG PRERELEASE...: replace the shim's release list (later args pairs).
release() {
	local items=() t p ts=0
	while [ $# -gt 0 ]; do
		t=$1 p=$2
		shift 2
		ts=$((ts + 1))
		items+=("$(jq -n -c --arg t "$t" --argjson p "$p" --arg d "2026-11-1${ts}T00:00:00Z" \
			'{tagName: $t, isPrerelease: $p, isDraft: false, publishedAt: $d}')")
	done
	printf '%s\n' "${items[@]}" | jq -s . >"$GH_RELEASES"
}

# up_commit MESSAGE FILE CONTENT [TAG]: new upstream commit, optionally tagged.
up_commit() {
	(
		cd "$W/up"
		mkdir -p "$(dirname "$3")"
		printf '%s\n' "$2" >>"$3"
		git add -A && git commit -q -m "$1"
		if [ $# -ge 4 ]; then git tag "$4"; fi
	)
}

oref() { git -C "$W/origin.git" rev-parse "$1"; }
oshow() { git -C "$W/origin.git" show "$1:$2" 2>/dev/null || true; }
subjects() { git -C "$W/origin.git" log --format=%s "$1" | head -n "$2" | paste -sd'|'; }
glog() { cat "$GH_LOG"; }
dispatches() { grep -c '^workflow run' "$GH_LOG" || true; }

run() { # args...: sets $code and $out (stdout JSON); stderr in $err
	set +e
	out=$("$WEEKLY" --repo "$W/clone" "$@" 2>"$W/stderr")
	code=$?
	set -e
}
field() { jq -r "$1" <<<"$out"; }

NEW=v0.1.11-nightly.20261117.4838

echo "== clean rebase (preview tag with a higher counter is ignored)"
world
up_commit 'Upstream change' more src/other.txt
up_commit 'Nightly 4838' x src/n.txt "$NEW"
up_commit 'Preview' y src/p.txt v0.1.11-preview.20261117.4900
before_mesh=$(oref mesh)
run
check 'exit 0' 0 "$code"
check 'status' rebased "$(field .status)"
check 'stack replayed' 'App identity|Add mTLS|Remove upstream workflows|Nightly 4838' "$(subjects candidate 4)"
check 'based on newest nightly' "$(git -C "$W/up" rev-parse "$NEW")" "$(oref candidate~3)"
check 'no upstream workflows' '' "$(git -C "$W/origin.git" ls-tree -r --name-only candidate | grep '^.github/workflows' || true)"
check 'fork change kept' 'name=t3mesh' "$(oshow candidate apps/mobile/app.config.ts | head -n 1)"
check 'mesh unchanged' "$before_mesh" "$(oref mesh)"
check 'one dispatch for the new tip' "workflow run release.yml --ref main -f commit=$(oref candidate)" "$(glog | grep '^workflow run')"
check 'dispatch count' 1 "$(dispatches)"
check 'user checkout untouched' '' "$(git -C "$W/clone" status --porcelain)"
check 'no leftover worktree' 1 "$(git -C "$W/clone" worktree list | wc -l)"

echo "== numeric build order (980 < 4838 although it sorts later as text)"
world
up_commit 'Old low counter' x src/a.txt v0.1.11-nightly.20261117.980
up_commit 'Nightly 4838' x src/n.txt "$NEW"
run
check 'newest nightly by number' "$NEW" "$(field .newest_nightly)"

echo "== already up to date"
world
up_commit 'Preview only' y src/p.txt v0.1.11-preview.20261117.4900
before=$(oref candidate)
run
check 'exit 0' 0 "$code"
check 'status' up_to_date "$(field .status)"
check 'candidate untouched' "$before" "$(oref candidate)"
check 'no dispatch' 0 "$(dispatches)"

echo "== workflow conflicts resolved by deletion"
world
(
	cd "$W/up"
	echo 'on: push' >>.github/workflows/ci.yml
	echo 'name: new' >.github/workflows/new.yml
	git add -A && git commit -q -m 'Workflow edits'
)
up_commit 'Nightly 4838' x src/n.txt "$NEW"
run
check 'exit 0' 0 "$code"
check 'status' rebased "$(field .status)"
check 'no upstream workflows (edited or new)' '' "$(git -C "$W/origin.git" ls-tree -r --name-only candidate | grep '^.github/workflows' || true)"
check 'three commits replayed' 3 "$(field '.applied | length')"
check 'dispatched' 1 "$(dispatches)"

echo "== real conflict: partial push, exit 3, report"
world
(
	cd "$W/up"
	sed -i 's/name=t3$/name=other/' apps/mobile/app.config.ts
	git add -A && git commit -q -m 'Upstream edits config'
)
up_commit 'Nightly 4838' x src/n.txt "$NEW"
run
check 'exit 3' 3 "$code"
check 'status' conflict "$(field .status)"
check 'candidate has clean prefix' 'Add mTLS|Remove upstream workflows|Nightly 4838' "$(subjects candidate 3)"
check 'based on newest nightly' "$(git -C "$W/up" rev-parse "$NEW")" "$(oref candidate~2)"
check 'remaining starts at conflicting commit' 'App identity' "$(field '.remaining[0].subject')"
check 'conflicting file reported' apps/mobile/app.config.ts "$(field '.conflict.files[0]')"
check 'remaining lists one commit' 1 "$(field '.remaining | length')"
check 'applied lists two' 2 "$(field '.applied | length')"
check 'no dispatch' 0 "$(dispatches)"
check 'remaining commit still resolvable' commit "$(git -C "$W/clone" cat-file -t "$(field '.remaining[0].sha')")"

echo "== open PR: candidate untouched, mesh still moves"
world
up_commit 'Nightly 4838' x src/n.txt "$NEW"
echo '[{"number":7,"title":"fix","url":"https://example.invalid/7"}]' >"$GH_PRS"
git -C "$W/origin.git" update-ref refs/heads/mesh "$(oref 'mesh~1')"
before=$(oref candidate)
run
check 'exit 0' 0 "$code"
check 'status' open_pr "$(field .status)"
check 'candidate untouched' "$before" "$(oref candidate)"
check 'mesh moved to release commit' "$before" "$(oref mesh)"
check 'no dispatch' 0 "$(dispatches)"

echo "== candidate ahead without release: rebase from candidate and dispatch"
world
(
	cd "$W/clone"
	git fetch -q origin
	git checkout -q --detach origin/candidate
	echo fix >modules/fix.txt && git add -A && git commit -q -m 'Merged fix'
	git push -q origin HEAD:candidate
	git checkout -q main
)
up_commit 'Nightly 4838' x src/n.txt "$NEW"
run
check 'exit 0' 0 "$code"
check 'source is candidate' candidate "$(field .source)"
check 'fix carried over' 'Merged fix|App identity' "$(subjects candidate 2)"
check 'dispatch for new tip' "workflow run release.yml --ref main -f commit=$(oref candidate)" "$(glog | grep '^workflow run')"
check 'mesh not moved to candidate' "$(git -C "$W/clone" rev-parse 'v0.1.11-nightly.20261117.4814+mesh.1^{commit}')" "$(oref mesh)"

echo "== candidate ahead without release, already on newest nightly: dispatch only"
world
(
	cd "$W/clone"
	git fetch -q origin
	git checkout -q --detach origin/candidate
	echo fix >modules/fix.txt && git add -A && git commit -q -m 'Merged fix'
	git push -q origin HEAD:candidate
	git checkout -q main
)
before=$(oref candidate)
run
check 'exit 0' 0 "$code"
check 'candidate not rewritten' "$before" "$(oref candidate)"
check 'dispatch for candidate tip' "workflow run release.yml --ref main -f commit=$before" "$(glog | grep '^workflow run')"

echo "== partial candidate (fewer commits than mesh) is not used as source"
world
(
	cd "$W/clone"
	git fetch -q origin
	git push -q -f origin origin/candidate~1:candidate
)
up_commit 'Nightly 4838' x src/n.txt "$NEW"
run
check 'source is mesh' mesh "$(field .source)"
check 'full stack restored' 'App identity|Add mTLS|Remove upstream workflows' "$(subjects candidate 3)"

echo "== held pre-release at candidate tip"
world
(
	cd "$W/clone"
	git fetch -q origin
	git checkout -q --detach origin/candidate
	echo fix >modules/fix.txt && git add -A && git commit -q -m 'Held fix'
	git push -q origin HEAD:candidate
	git tag held && git push -q origin held
	git checkout -q main
)
release 'v0.1.11-nightly.20261117.4814+mesh.1' false held true
up_commit 'Nightly 4838' x src/n.txt "$NEW"
before=$(oref candidate)
run
check 'exit 0' 0 "$code"
check 'status' held "$(field .status)"
check 'candidate untouched' "$before" "$(oref candidate)"
check 'no dispatch' 0 "$(dispatches)"

echo "== dry run changes nothing remote"
world
up_commit 'Nightly 4838' x src/n.txt "$NEW"
git -C "$W/origin.git" update-ref refs/heads/mesh "$(oref 'mesh~1')"
before_c=$(oref candidate)
before_m=$(oref mesh)
run --dry-run --report "$W/report.json"
check 'exit 0' 0 "$code"
check 'stdout empty with --report' '' "$out"
check 'candidate untouched' "$before_c" "$(oref candidate)"
check 'mesh untouched' "$before_m" "$(oref mesh)"
check 'no gh dispatch' 0 "$(dispatches)"
check 'report is dry run' true "$(jq -r .dry_run "$W/report.json")"
check 'actions list push and dispatch' 3 "$(jq '.actions | length' "$W/report.json")"
check_true 'stderr shows dry-run actions' grep -q '^dry-run: git push' "$W/stderr"

echo "== dirty tree refused"
world
echo dirty >>"$W/clone/README.md"
run
check 'exit 1' 1 "$code"
check_true 'message' grep -q 'uncommitted' "$W/stderr"

echo
echo "passed: $pass, failed: $fail"
[ "$fail" -eq 0 ]
