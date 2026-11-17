#!/usr/bin/env bash
# Weekly upkeep for the Android fork: move `mesh` to the newest published release,
# rebase the patch stack onto the newest upstream nightly and publish `candidate`.
# See docs/android-fork.md ("Weekly upkeep") and scripts/upkeep/README.md.
#
# Exit codes: 0 done / nothing to do / blocked by an open PR, 1 error, 2 usage,
# 3 rebase conflict (candidate was pushed with the commits that applied).
set -euo pipefail

EXIT_CONFLICT=3
NIGHTLY_RE='^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$'
WORKFLOWS_DIR='.github/workflows'

DRY=false
REPO=.
REPORT=
actions=()
WORK=
mesh_sha='' cand_sha='' source='' source_sha='' base_tag='' newest_tag='' mesh_moved_to=''

log() { printf '%s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

usage() {
	cat >&2 <<'EOF'
usage: weekly.sh [--repo DIR] [--dry-run] [--report FILE]

  --repo DIR     clone to operate on (default: current directory)
  --dry-run      print the pushes and dispatches instead of doing them
  --report FILE  write the JSON report to FILE instead of stdout
EOF
}

# shellcheck disable=SC2329
cleanup() {
	if [ -n "$WORK" ]; then
		git worktree remove --force "$WORK/wt" >/dev/null 2>&1 || true
		git worktree prune >/dev/null 2>&1 || true
		rm -rf "$WORK"
	fi
}

# act CMD...: run a command that changes a remote, or only print it in dry-run mode.
act() {
	actions+=("$*")
	if $DRY; then
		log "dry-run: $*"
	else
		log "+ $*"
		"$@"
	fi
}

report() { # status exit-code message [extra-json]
	local extra=${4:-'{}'} acts='[]' out
	if [ "${#actions[@]}" -gt 0 ]; then
		acts=$(printf '%s\n' "${actions[@]}" | jq -R . | jq -s .)
	fi
	out=$(jq -n \
		--arg status "$1" --arg message "$3" --argjson dry "$DRY" \
		--argjson actions "$acts" --argjson extra "$extra" \
		--arg mesh "$mesh_sha" --arg candidate "$cand_sha" --arg source "$source" \
		--arg source_sha "$source_sha" --arg base "$base_tag" --arg newest "$newest_tag" \
		--arg mesh_moved_to "$mesh_moved_to" \
		'{status: $status, message: $message, dry_run: $dry,
		  mesh: $mesh, candidate: $candidate, source: $source, source_sha: $source_sha,
		  base_nightly: $base, newest_nightly: $newest, mesh_moved_to: $mesh_moved_to,
		  actions: $actions} + $extra')
	if [ -n "$REPORT" ]; then
		printf '%s\n' "$out" >"$REPORT"
	else
		printf '%s\n' "$out"
	fi
	log "$1: $3"
	exit "$2"
}

rsha() { git rev-parse --verify --quiet "$1^{commit}" 2>/dev/null || true; }

# Valid nightly tag names reachable from a ref (all tags when no ref), highest
# build number last. Only -nightly. tags qualify; preview tags share the counter.
nightlies() {
	local merged=()
	[ $# -gt 0 ] && merged=(--merged "$1")
	git tag "${merged[@]}" -l 'v*-nightly.*' | grep -E "$NIGHTLY_RE" |
		awk -F. '{print $NF, $0}' | sort -n -k1,1 | cut -d' ' -f2- || true
}

count_stack() { git rev-list --count "$1..$2"; }

# push_branch BRANCH SHA EXPECTED: lease-protected force push of origin/BRANCH.
push_branch() {
	act git push --force-with-lease="refs/heads/$1:$3" origin "$2:refs/heads/$1"
}

while [ $# -gt 0 ]; do
	case $1 in
	--repo) [ $# -ge 2 ] || { usage; exit 2; }; REPO=$2; shift 2 ;;
	--dry-run) DRY=true; shift ;;
	--report) [ $# -ge 2 ] || { usage; exit 2; }; REPORT=$2; shift 2 ;;
	-h | --help) usage; exit 0 ;;
	*) usage; exit 2 ;;
	esac
done

for tool in git jq gh; do
	command -v "$tool" >/dev/null || die "$tool is required"
done
cd "$REPO" || die "cannot enter $REPO"
git rev-parse --git-dir >/dev/null 2>&1 || die "$REPO is not a git repository"
cd "$(git rev-parse --show-toplevel)"

# The user's checkout is never modified: rebasing happens in a temporary worktree.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
	die "working tree has uncommitted changes; refusing to run"
fi
git remote get-url origin >/dev/null || die "no origin remote"
git remote get-url upstream >/dev/null || die "no upstream remote"
if [ -z "${GH_REPO:-}" ]; then
	slug=$(git remote get-url origin | sed -nE 's#^(git@|ssh://git@|https://)github\.com[:/]([^/]+/[^/]+)$#\2#p')
	slug=${slug%.git}
	[ -n "$slug" ] && export GH_REPO=$slug
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/weekly-upkeep.XXXXXX")
trap cleanup EXIT

log "fetching origin and upstream"
git fetch --quiet origin --tags
git fetch --quiet upstream --tags

newest_tag=$(nightlies | tail -n 1)
[ -n "$newest_tag" ] || die "no upstream nightly tags found"
newest_sha=$(rsha "refs/tags/$newest_tag")

# Step 2: move mesh. Releases are what was built, signed and (unless held as a
# pre-release for the owner's device check) accepted, so mesh follows the newest
# published release that is neither a draft nor a pre-release.
releases=$(gh release list --limit 200 --json tagName,isPrerelease,isDraft,publishedAt)
mesh_tag=$(jq -r '[.[] | select(.isDraft == false and .isPrerelease == false)]
	| sort_by(.publishedAt) | last | .tagName // empty' <<<"$releases")
# One "<commit> <pre-release?>" line per non-draft release, for tip lookups.
release_tips=$(
	while IFS=$'\t' read -r tag pre; do
		sha=$(rsha "refs/tags/$tag")
		if [ -n "$sha" ]; then printf '%s %s\n' "$sha" "$pre"; fi
	done < <(jq -r '.[] | select(.isDraft == false) | [.tagName, .isPrerelease] | @tsv' <<<"$releases")
)

origin_mesh=$(rsha refs/remotes/origin/mesh)
if [ -n "$mesh_tag" ]; then
	target=$(rsha "refs/tags/$mesh_tag")
	[ -n "$target" ] || die "release tag $mesh_tag is not fetched from origin"
	if [ "$target" != "$origin_mesh" ]; then
		push_branch mesh "$target" "$origin_mesh"
		mesh_moved_to=$target
		origin_mesh=$target
	fi
else
	log "no published release yet; mesh stays where it is"
fi
mesh_sha=$origin_mesh
origin_cand=$(rsha refs/remotes/origin/candidate)
cand_sha=$origin_cand

# Step 3: an open fix PR owns candidate.
prs=$(gh pr list --base candidate --state open --json number,title,url)
if [ "$(jq length <<<"$prs")" -gt 0 ]; then
	report open_pr 0 "open PR(s) into candidate; not touching candidate" \
		"$(jq -c '{open_prs: .}' <<<"$prs")"
fi

# Step 4: choose the rebase source.
source=mesh
source_sha=$mesh_sha
cand_ahead=false
if [ -n "$cand_sha" ] && [ "$cand_sha" != "$mesh_sha" ]; then
	tip_nonpre=$(awk -v s="$cand_sha" '$1 == s && $2 == "false"' <<<"$release_tips")
	tip_pre=$(awk -v s="$cand_sha" '$1 == s && $2 == "true"' <<<"$release_tips")
	cand_base=$(nightlies "$cand_sha" | tail -n 1)
	[ -n "$cand_base" ] || die "candidate is not based on an upstream nightly tag"
	cand_n=$(count_stack "refs/tags/$cand_base" "$cand_sha")
	mesh_n=0
	if [ -n "$mesh_sha" ]; then
		mesh_base=$(nightlies "$mesh_sha" | tail -n 1)
		mesh_n=$(count_stack "refs/tags/$mesh_base" "$mesh_sha")
	fi
	if [ -z "$mesh_sha" ]; then
		cand_ahead=true
	elif [ -n "$tip_nonpre" ]; then
		log "candidate tip already has a release; using mesh"
	elif [ -n "$tip_pre" ]; then
		report held 0 "candidate tip has a held pre-release; promote or discard it before the next rebase"
	elif [ "$cand_n" -ge "$mesh_n" ]; then
		cand_ahead=true
	else
		log "candidate has fewer stack commits than mesh (partial push?); using mesh"
	fi
fi
if $cand_ahead; then
	source=candidate
	source_sha=$cand_sha
fi
[ -n "$source_sha" ] || die "neither mesh nor candidate exists on origin"

base_tag=$(nightlies "$source_sha" | tail -n 1)
[ -n "$base_tag" ] || die "$source is not based on an upstream nightly tag"
base_sha=$(rsha "refs/tags/$base_tag")

# Step 5: already on the newest nightly.
if [ "$base_tag" = "$newest_tag" ]; then
	if $cand_ahead; then
		act gh workflow run release.yml --ref main -f commit="$cand_sha"
		report dispatched 0 "candidate is on the newest nightly with no release; build dispatched"
	fi
	report up_to_date 0 "already on the newest nightly"
fi

[ -z "$(git rev-list --merges "$base_sha..$source_sha")" ] || die "the stack contains merge commits"
mapfile -t stack < <(git rev-list --reverse --topo-order "$base_sha..$source_sha")
[ "${#stack[@]}" -gt 0 ] || die "empty stack on $base_tag"

# Step 6: replay the stack onto the newest nightly, commit by commit.
git worktree add --detach --quiet "$WORK/wt" "$newest_sha"
wt() { git -C "$WORK/wt" "$@"; }

applied='[]'
conflict='null'
remaining='[]'
first=true
for i in "${!stack[@]}"; do
	c=${stack[$i]}
	subject=$(git log -1 --format=%s "$c")
	if ! wt cherry-pick --empty=drop "$c" >/dev/null 2>&1; then
		mapfile -t unmerged < <(wt diff --name-only --diff-filter=U)
		only_workflows=false
		if [ "${#unmerged[@]}" -gt 0 ]; then
			only_workflows=true
			for f in "${unmerged[@]}"; do
				[[ $f == "$WORKFLOWS_DIR/"* ]] || only_workflows=false
			done
		fi
		if $only_workflows; then
			log "resolving upstream workflow conflicts by deleting: ${unmerged[*]}"
			wt rm -q -f -- "${unmerged[@]}"
			GIT_EDITOR=true wt cherry-pick --continue >/dev/null
		else
			conflict=$(jq -n --arg sha "$c" --arg subject "$subject" \
				--argjson files "$(printf '%s\n' "${unmerged[@]}" | jq -R . | jq -s 'map(select(length > 0))')" \
				'{sha: $sha, subject: $subject, files: $files}')
			wt cherry-pick --abort >/dev/null 2>&1 || wt reset --hard -q HEAD
			for r in "${stack[@]:$i}"; do
				remaining=$(jq -c --arg sha "$r" --arg subject "$(git log -1 --format=%s "$r")" \
					'. + [{sha: $sha, subject: $subject}]' <<<"$remaining")
			done
			break
		fi
	fi
	if $first; then
		# The first commit removes upstream's workflows; also drop any added upstream
		# since the old base so that nothing of upstream's stays in the tree.
		if [ -n "$(wt ls-files -- "$WORKFLOWS_DIR")" ]; then
			wt rm -r -q -f -- "$WORKFLOWS_DIR"
			wt commit --amend --no-edit --no-verify --allow-empty -q
		fi
		first=false
	fi
	applied=$(jq -c --arg sha "$(wt rev-parse HEAD)" --arg orig "$c" --arg subject "$subject" \
		'. + [{sha: $sha, original: $orig, subject: $subject}]' <<<"$applied")
done
new_tip=$(wt rev-parse HEAD)

extra=$(jq -n -c --argjson applied "$applied" --argjson conflict "$conflict" \
	--argjson remaining "$remaining" --arg tip "$new_tip" --arg before "$origin_cand" \
	'{candidate_before: $before, candidate_after: $tip, applied: $applied,
	  conflict: $conflict, remaining: $remaining}')

# Step 6, conflict: candidate gets the commits that applied; the agent finishes the rest.
if [ "$conflict" != null ]; then
	push_branch candidate "$new_tip" "$origin_cand"
	cand_sha=$new_tip
	report conflict "$EXIT_CONFLICT" \
		"conflict at $(jq -r '.sha' <<<"$conflict"); candidate holds the commits that applied" "$extra"
fi

# Step 7: clean path.
if [ "$new_tip" != "$origin_cand" ]; then
	push_branch candidate "$new_tip" "$origin_cand"
fi
cand_sha=$new_tip
act gh workflow run release.yml --ref main -f commit="$new_tip"
report rebased 0 "candidate rebased onto $newest_tag; build dispatched" "$extra"
