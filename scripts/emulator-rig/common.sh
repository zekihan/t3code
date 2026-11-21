#!/usr/bin/env bash

adb_bin=${ADB:-$HOME/Android/Sdk/platform-tools/adb}

die() { printf '%s\n' "$*" >&2; exit 1; }

rig_config() {
  rig=$(cd -- "${T3_RIG_DIR:?Set T3_RIG_DIR to the scratch directory printed by run.sh}" && pwd)
  [[ -f "$rig/ready" ]] || die "Rig is not ready in $rig"
  # shellcheck disable=SC1091
  source "$rig/addresses"
}

emulator_config() {
  local serial=${ANDROID_SERIAL:-}
  if [[ -z "$serial" ]]; then
    local -a emulators
    mapfile -t emulators < <("$adb_bin" devices | awk '$1 ~ /^emulator-[0-9]+$/ && $2 == "device" {print $1}')
    [[ ${#emulators[@]} == 1 ]] || die "Boot one emulator or set ANDROID_SERIAL to its emulator serial"
    serial=${emulators[0]}
  fi
  [[ "$serial" =~ ^emulator-[0-9]+$ ]] || die "Use a disposable Android emulator"
  [[ $("$adb_bin" -s "$serial" shell getprop ro.kernel.qemu | tr -d '\r') == 1 ]] ||
    die "ADB target $serial did not identify itself as an emulator"
  # shellcheck disable=SC2034
  adb_cmd=("$adb_bin" -s "$serial")
}

device() {
  local -a target_args
  mapfile -t target_args < "${T3_RIG_DEVICE_ARGS:?Set T3_RIG_DEVICE_ARGS to a file with the Device panel target args, one per line}"
  "${AGENT_DEVICE:-agent-device}" "$@" "${target_args[@]}"
}

ui_wait() { device wait "$1" "${2:-15000}" >/dev/null; }
ui_tap() {
  ui_wait "$1" "${2:-15000}"
  device press "$1" >/dev/null
}
ui_fill() {
  ui_wait "$1"
  device fill "$1" "$2" >/dev/null
}

pick_download() {
  local roots='label="Show roots"' downloads='label="Downloads" id="android:id/title"'
  local file="label=\"$1\" id=\"android:id/title\""
  ui_wait "$roots"
  if ! device snapshot --json | jq -e 'any(.data.nodes[]; .visibleToUser and .label == "Files in Downloads")' >/dev/null; then
    device press "$roots" --settle >/dev/null
    ui_wait "$downloads"
    device press "$downloads" --settle >/dev/null
  fi
  ui_wait "$file"
  device press "$file" --settle >/dev/null
}
