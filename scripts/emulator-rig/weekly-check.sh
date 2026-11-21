#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR
source "$script_dir/common.sh"

[[ $# == 1 && -f "$1" ]] || die "Usage: $0 <x86_64 mesh APK>"
app=com.noqer.t3mesh
t3=${T3_BIN:-t3}
rig_config
emulator_config
out=${T3_RIG_OUTPUT:-$(mktemp -d "${TMPDIR:-/tmp}/t3-mesh-weekly.XXXXXXXX")}
mkdir -p -- "$out"
out=$(cd -- "$out" && pwd)
step=setup
hub_down=0
mesh_log="$rig/logs/mesh.log"
echo "Evidence: $out"

control() { curl --noproxy '*' --max-time 5 -fsS "$@"; }
wait_for_recorded_message() {
  local role=$1 message=$2 evidence=$3 deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do
    if timeout 5 "$t3" thread show --base-dir "$rig/t3" --json "$thread_id" >"$evidence" &&
      jq -e --arg role "$role" --arg message "$message" \
        'any(.messages[]; .role == $role and .text == $message)' "$evidence" >/dev/null; then
      return
    fi
    sleep 0.25
  done
  echo "T3 did not record the expected $role message in $thread_id." >&2
  return 1
}
wait_for_claimed_attachment() {
  local fixture=$1 stored deadline=$((SECONDS + 15))
  while ((SECONDS < deadline)); do
    for stored in "$rig/t3/userdata/attachments/"*.txt; do
      [[ -f "$stored" && ${stored##*/} != pending-* ]] || continue
      if cmp -s "$fixture" "$stored"; then
        sha256sum "$fixture" "$stored" >"$out/attachment.sha256"
        return
      fi
    done
    sleep 0.25
  done
  echo "T3 has no claimed attachment with the fixture bytes." >&2
  return 1
}
finish() {
  local status=$?
  trap - EXIT
  if ((hub_down)); then
    control "$CONTROL_URL/hub?up=1" >/dev/null || true
  fi
  if [[ -n ${attachment:-} ]]; then
    "${adb_cmd[@]}" shell rm -f "/sdcard/Download/$attachment" >/dev/null 2>&1 || true
  fi
  if ((status)); then
    device snapshot --force-full >"$out/failure.txt" 2>&1 || true
    "$script_dir/shot.sh" "$out/failure.png" 2>/dev/null || true
    echo "FAIL $step (line ${failed_line:-unknown}). See $out and $rig/logs." >&2
  fi
}
trap finish EXIT
trap 'failed_line=$LINENO' ERR
trap 'exit 130' INT
trap 'exit 143' TERM

begin() { step=$1; echo "Checking $step"; }
capture() { "$script_dir/shot.sh" "$out/$step.png"; }
app_open() { device open "$app" "$@" >/dev/null; }

open_mesh() {
  ui_tap 'label="Settings"'
  ui_tap 'label="Mesh"'
}

new_thread() {
  local new='label="New thread" role="button"'
  ui_wait "$new"
  device press "$new" --settle >/dev/null
  if device snapshot --json | jq -e 'any(.data.nodes[]; .visibleToUser and .label == "Choose project")' >/dev/null; then
    ui_tap "label=\"Rig Workspace, $rig/workspace\""
  fi
  ui_wait 'label="Ask anything"'
  local model ref
  model=$(device snapshot --json | jq -ce '
    first(.data.nodes[] | select(.kind == "button" and ((.label // "") | startswith("Model and reasoning settings,"))))
  ')
  if jq -e '.label | contains("Multi turn")' <<<"$model" >/dev/null; then
    return
  fi
  ref=$(jq -r '"@" + .ref' <<<"$model")
  device press "$ref" >/dev/null
  ui_fill 'label="Find a model"' 'Multi turn'
  ui_tap 'label="Multi turn" role="radiobutton"'
  ui_tap 'label="Save"'
  ui_wait 'label="Ask anything"'
}

send() {
  local message=$1
  ui_fill 'label="Ask anything"' "$message"
  ui_tap 'label="Send" enabled=true'
  ui_wait "label=\"$message\" editable=false" 30000
}

begin install
"${adb_cmd[@]}" install -r "$1"
# Exercise a clean pairing every run on the disposable AVD.
"${adb_cmd[@]}" shell pm clear "$app" | grep -qx Success
app_open

begin machines
ui_tap 'label="Find machines on the mesh"'
ui_wait 'label="RigViewer" id="com.android.keychain:id/cert_item_alias"'
radio=$(device snapshot --json | jq -er '
  .data.nodes as $nodes |
  first($nodes[] | select(.identifier == "com.android.keychain:id/cert_item_alias" and .label == "RigViewer")) as $alias |
  first($nodes[] | select(.parentIndex == $alias.parentIndex and .identifier == "com.android.keychain:id/cert_item_selected")) |
  "@" + .ref
')
device press "$radio" >/dev/null
ui_tap 'label="SELECT" enabled=true'
ui_wait 'label="Pair rig"' 30000
capture

begin fleet
ui_tap 'label="Fleet"'
ui_wait "label=\"Agent $AGENT_VERSION\""
capture

begin pair
ui_tap 'label="Machines"'
ui_tap 'label="Pair rig"'
token=$("$t3" auth pairing create --base-dir "$rig/t3" --ttl 2h --json | jq -er '.credential')
ui_fill 'label="Pairing code" editable=true' "$token"
ui_tap 'label="Add environment" role="button" enabled=true'
unset token
ui_wait 'label="Open rig"' 30000
capture

begin chat
ui_tap 'label="Chats"'
new_thread
send "Rig chat $(date +%s)"
thread_id=$("$t3" thread list --base-dir "$rig/t3" --project "$rig/workspace" --json | jq -er '.[0].threadId')
wait_for_recorded_message assistant 'first fixture turn complete' "$out/chat.json"
capture

begin reconnect
message="Rig reconnected $(date +%s)"
ui_fill 'label="Ask anything"' "$message"
ui_wait 'label="Send" enabled=true'
hub_down=1
control "$CONTROL_URL/hub?up=0&mode=503" >/dev/null
ui_wait 'label="Queue" enabled=true' 30000
capture
control "$CONTROL_URL/hub?up=1" >/dev/null
hub_down=0
ui_tap 'label="Send" enabled=true' 30000
ui_wait 'label="Ask anything" editable=true'
wait_for_recorded_message user "$message" "$out/relay-after-reconnect.json"
"$script_dir/shot.sh" "$out/reconnected.png"

begin attachment
ui_tap 'label="Navigate up"'
new_thread
attachment="RigAttachment-$(date +%s).txt"
printf 'Emulator attachment upload check %s\n' "$attachment" > "$out/$attachment"
"${adb_cmd[@]}" push "$out/$attachment" "/sdcard/Download/$attachment" >/dev/null
ui_tap 'label="Add attachment"'
ui_tap 'label="Choose Files"'
pick_download "$attachment"
ui_tap 'label="Send" enabled=true'
ui_wait "label=\"$attachment\" editable=false"
wait_for_claimed_attachment "$out/$attachment"
capture

begin enrollment
device back >/dev/null
open_mesh
ui_tap 'label="Device"'
ui_tap 'label="Enroll this device" role="button"'
token=$(control -X POST "$CONTROL_URL/enroll")
ui_fill 'label="device-z-phone-mesh" editable=true' device-rig-mesh
ui_fill 'label="Paste the one-time token" editable=true' "$token"
ui_tap 'label="Enroll" role="button" enabled=true'
unset token
ui_wait 'label="Enrolled as device-rig-mesh"' 30000
capture

begin direct
ui_tap 'label="Chats"'
new_thread
send "Rig direct warmup $(date +%s)"
hub_down=1
control "$CONTROL_URL/hub?up=0" >/dev/null
start_line=$(wc -l < "$mesh_log")
app_open --relaunch
new_thread
send "Rig direct with hub down $(date +%s)"
tail -n "+$((start_line + 1))" "$mesh_log" |
  grep -E 'Device stream.*peer=device-rig-mesh.*upgrade=true' >"$out/direct.log"
capture
control "$CONTROL_URL/hub?up=1" >/dev/null
hub_down=0

echo "PASS. Evidence: $out"
