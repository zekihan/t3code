#!/usr/bin/env bash
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
device screenshot --out "${1:?Usage: shot.sh <output.png>}" >/dev/null
