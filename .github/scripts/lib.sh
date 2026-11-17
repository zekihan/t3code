#!/usr/bin/env bash
# shellcheck disable=SC2034 # each script uses a subset of the constants
# Shared helpers and the single definition of every format the workflows trust.
# Sourced by the other scripts; not executable on its own.

die() {
  echo "::error::$*" >&2
  exit 1
}

RE_SHA='^[0-9a-f]{40}$'
RE_NIGHTLY_TAG='^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$'
RE_RELEASE_NAME='^[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+\+mesh\.[0-9]{1,2}$'
RE_VERSION_NAME='^[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+\+mesh\.[0-9]{1,2}(\.rollback(\.[0-9]{1,2})?)?$'
RE_VERSION_CODE='^[1-9][0-9]{0,9}$'
RE_TOOLCHAIN_ID='^[a-z0-9][a-z0-9.-]{0,39}$'
RE_SHA256='^[0-9a-f]{64}$'
MAX_VERSION_CODE=2100000000

# require_match <label> <regex> <value>
require_match() {
  [[ $3 =~ $2 ]] || die "$1 has an unexpected format"
}

# require_version_code <label> <value>: format and Android's upper bound.
require_version_code() {
  require_match "$1" "$RE_VERSION_CODE" "$2"
  ((10#$2 <= MAX_VERSION_CODE)) || die "$1 exceeds $MAX_VERSION_CODE"
}

# nightly_build_number <nightly or tag>: the trailing counter.
nightly_build_number() {
  echo "${1##*.}"
}
