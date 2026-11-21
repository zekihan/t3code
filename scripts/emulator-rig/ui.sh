#!/usr/bin/env bash
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

case "${1:-dump}" in
  dump) device snapshot --force-full ;;
  text) ui_tap "label=\"${2:?Supply the exact label}\"" ;;
  id) ui_tap "id=\"${2:?Supply the resource ID}\"" ;;
  *) die "Usage: $0 [dump | text <label> | id <resource-id>]" ;;
esac
