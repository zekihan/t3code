#!/usr/bin/env bash
# shellcheck disable=SC2329
set -Eeuo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$script_dir" rev-parse --show-toplevel)
mesh_repo=${T3_MESH_REPO:-$HOME/repos/github.com/zekihan/t3-mesh}
mesh_ref=${T3_MESH_REF:-488853c7726263dd031f6ac5cfb76f40b0bf5f20}
candidate_ref=${T3_CANDIDATE_REF:-origin/candidate}
t3=$(realpath -- "$(command -v "${T3_BIN:-t3}")")
t3_port=${T3_RIG_SERVER_PORT:-38773}
caddy_port=${T3_RIG_CADDY_PORT:-8443}
lan=${T3_RIG_LAN_IP:-$(ip -4 route get 1.0.0.1 | awk '{for (i=1; i<NF; i++) if ($i=="src") print $(i+1)}')}
if [[ $# -gt 1 || -z "$lan" ]]; then
  echo "Usage: $0 [scratch-dir] (set T3_RIG_LAN_IP if the host has no default private IPv4)" >&2
  exit 2
fi
dir=${1:-$(mktemp -d "${TMPDIR:-/tmp}/t3-mesh-rig.XXXXXXXX")}
mkdir -p -- "$dir"
dir=$(cd -- "$dir" && pwd)
if [[ ! -f "$dir/.emulator-rig-scratch" && -n "$(find "$dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Use an empty directory for the rig: $dir" >&2
  exit 1
fi
chmod 700 "$dir"
touch "$dir/.emulator-rig-scratch"
exec 9>"$dir/run.lock"
flock -n 9 || { echo "Rig already running in $dir" >&2; exit 1; }

pids=()
cleanup() {
  rm -f -- "$dir/ready"
  local pid
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
rm -f -- "$dir/ready" "$dir/addresses"

mkdir -p "$dir/mesh/cmd/emulator-rig" "$dir/candidate" "$dir/t3/userdata" "$dir/workspace" "$dir/logs"
git -C "$mesh_repo" archive "$mesh_ref" | tar -x -C "$dir/mesh"
version=v$(<"$dir/mesh/VERSION")
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid mesh version: $version" >&2; exit 1; }
cp -- "$script_dir"/*.go "$dir/mesh/cmd/emulator-rig/"
(
  cd "$dir/mesh"
  go vet ./cmd/emulator-rig
  go build -o "$dir/emulator-rig" ./cmd/emulator-rig
)

git -C "$repo" archive "$candidate_ref" apps/server/scripts apps/server/src/orchestration-v2/testkit/fixtures |
  tar -x -C "$dir/candidate"
replay="$dir/candidate/apps/server/scripts/dev-replay-agent.ts"
node - "$(command -v node)" "$replay" "$dir/t3/userdata/settings.json" <<'JS'
const fs = require("node:fs");
const [commandPath, script, output] = process.argv.slice(2);
const drivers = ["codex", "claudeAgent", "cursor", "grok", "fx", "opencode", "antigravity", "kiro", "pi", "muse"];
const providerInstances = Object.fromEntries(drivers.map(driver => [driver, { driver, enabled: false }]));
providerInstances.emulatorReplay = {
  displayName: "Rig Replay",
  driver: "acpRegistry",
  config: { source: "local", commandPath, commandArgs: [script] }
};
fs.writeFileSync(output, JSON.stringify({ providerInstances }));
JS
if [[ ! -d "$dir/workspace/.git" ]]; then
  git init -q "$dir/workspace"
fi

# Bind to loopback so only the emulator's reverse and the agent's LAN listener can reach the rig.
echo "Rig scratch directory: $dir"
(
  cd "$dir/workspace"
  export T3CODE_ENVIRONMENT_LABEL="Rig Environment"
  exec "$t3" serve --host 127.0.0.1 --port "$t3_port" --base-dir "$dir/t3" --no-browser
) 9>&- >"$dir/logs/t3.log" 2>&1 &
pids+=("$!")
"$dir/emulator-rig" "$dir" "127.0.0.1:$caddy_port" "$lan" "$version" 9>&- >"$dir/logs/mesh.log" 2>&1 &
pids+=("$!")

wait_for() {
  local label=$1
  shift
  for ((i=0; i<80; i++)); do
    if "$@"; then return; fi
    sleep 0.25
  done
  echo "$label failed to start. See $dir/logs." >&2
  return 1
}
wait_for "Mesh rig" test -s "$dir/addresses"
# shellcheck disable=SC1091
source "$dir/addresses"
t3_ready() {
  [[ -s "$dir/t3/userdata/environment-id" ]] || return 1
  curl --noproxy '*' --max-time 2 -fs "http://127.0.0.1:$t3_port/.well-known/t3/environment" |
    jq -e --arg id "$(<"$dir/t3/userdata/environment-id")" '.environmentId == $id' >/dev/null
}
wait_for "T3 server" t3_ready
if [[ ! -f "$dir/project-created" ]]; then
  timeout 30 "$t3" project add --base-dir "$dir/t3" --title "Rig Workspace" "$dir/workspace" >>"$dir/logs/t3.log" 2>&1
  touch "$dir/project-created"
fi
cat > "$dir/Caddyfile" <<CADDY
{
  admin off
  auto_https disable_redirects
}
https://:$caddy_port {
  bind 127.0.0.1
  tls "$dir/tls.crt" "$dir/tls.key" {
    client_auth {
      mode require_and_verify
      trust_pool file "$dir/ca.crt"
    }
  }
  reverse_proxy 127.0.0.1:$t3_port
}
CADDY
XDG_CONFIG_HOME="$dir/caddy-config" XDG_DATA_HOME="$dir/caddy-data" caddy run --config "$dir/Caddyfile" --adapter caddyfile 9>&- >"$dir/logs/caddy.log" 2>&1 &
pids+=("$!")

mesh_curl() {
  local host=$1
  local path=$2
  curl --noproxy '*' --max-time 3 --silent --fail     --connect-to "$host:443:127.0.0.1:$FRONT_PORT"     --cacert "$dir/ca.crt" --cert "$dir/viewer.crt" --key "$dir/viewer.key" "https://$host/$path"
}
direct_advertised() {
  mesh_curl hub.mesh.noqer.com api/v1/machines |
    jq -e --arg address "${DEVICE_ADDRESS%:*}" --argjson port "${DEVICE_ADDRESS##*:}"       '.machines[] | select(.name == "rig" and .online and .direct.address == $address and .direct.port == $port)' >/dev/null
}
wait_for "Agent direct advertisement" direct_advertised
viewer_ready() {
  mesh_curl t3.rig.mesh.noqer.com .well-known/t3/environment |
    jq -e '.label == "Rig Environment"' >/dev/null
}
wait_for "mTLS viewer" viewer_ready

cat >> "$dir/addresses" <<PORTS
T3_PORT=$t3_port
CADDY_PORT=$caddy_port
AGENT_VERSION=$version
PORTS
touch "$dir/ready"
printf 'Enrollment: mesh.noqer.com:443\nMesh API: https://hub.mesh.noqer.com\nViewer: https://t3.rig.mesh.noqer.com\n'
printf 'ADB reverse target: 127.0.0.1:%s\nDirect device listener: %s\nControl: %s\nCaddy: 127.0.0.1:%s\nT3: 127.0.0.1:%s\n'   "$FRONT_PORT" "$DEVICE_ADDRESS" "$CONTROL_URL" "$caddy_port" "$t3_port"
wait -n "${pids[@]}"
echo "A rig service exited. See $dir/logs." >&2
exit 1
