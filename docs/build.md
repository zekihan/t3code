# Build setup

The workflows implement "Build and distribution" in [android-fork.md](android-fork.md).
Repository settings live in homelab `terraform/git`, not here.

## Settings the workflows rely on

- Default workflow token read-only; rebase-merge only; ruleset on `main`.
- Environment `release`: deployment branches limited to `main`.
  - Secrets: `ANDROID_SIGNING_KEYSTORE_B64` (base64 of the keystore),
    `ANDROID_SIGNING_KEYSTORE_PASSWORD`, `ANDROID_SIGNING_KEY_ALIAS`,
    `ANDROID_SIGNING_KEY_PASSWORD`.
- Actions enabled, with `main` as the default branch (schedules run from it).

## Workflows

| File | Trigger | Does |
|---|---|---|
| `release.yml` | dispatch with a `candidate` commit | build without secrets, then sign and publish |
| `rollback.yml` | dispatch with a release tag | rebuild that release's commit, publish it as `<versionName>.rollback` under the next `versionCode` |
| `daily-check.yml` | daily, dispatch | dispatches `release.yml` for an unbuilt `candidate` tip |

`release` and `rollback` share the `release` concurrency group, which keeps one
pending run at most (GitHub drops older pending runs). The logic is in
`.github/scripts`; test it with `bash .github/scripts/test/run.sh`.

## Versions

- `versionName` is `<nightly>+mesh.<rev>`; `rev` is one above the highest published
  `rev` for that nightly (pre-releases included, rollbacks not), 1 to 99.
- Every release body ends with machine-readable lines written by the release job:
  `t3mesh-commit`, `t3mesh-base`, `t3mesh-version-code`, `t3mesh-target-sdk`,
  `t3mesh-toolchain`, `t3mesh-cert-sha256`. They are the source of truth for the
  highest published `versionCode` and for rollback. Do not edit them.
- The release asset is `t3-mesh-<versionName>.apk` with `+` replaced by `-`. The tag
  keeps the `+` (`v0.1.11-nightly.20261117.4814+mesh.1`); URLs need it as `%2B`.

## Toolchain sets

`.github/toolchain/current` names the set in `.github/toolchain/sets/<id>.env` that
builds use. A release records its set id in its body, and rollback rebuilds with
that set, so a set must never change or be deleted after a release used it. To
change a version, add a new set file and point `current` at it in a commit to
`main`; workflows never push. A value still reading `TODO` fails the build.
The `main` workflows read all of this from `main`, never from the artifact.

## Android signing

Release and rollback APKs require Android 9 (API 28) or later. They use the
current release key and the APK v3 signing lineage in
`.github/signing/t3mesh.lineage`. The publish job checks the embedded lineage
and requires its latest certificate to match the verified APK signer.
Android 7 and 8 cannot follow an APK v3 signing lineage and remain on their
last compatible release.

## Known limits

- The build job's output is hostile; the release job checks the APK's fields with
  pinned tools but cannot prove the code is benign (accepted risk in the plan).
- The release job verifies the base tag against upstream and the compare API
  (`verify-base.sh`), so a hostile build cannot inflate the versionCode.
- The daily check skips a `candidate` whose stack has fewer commits than `mesh`'s,
  so a partial stack left by a rebase conflict is never built.
- The daily check re-dispatches a tip whose build failed each day until it is fixed.
