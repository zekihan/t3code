#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

[[ $# == 0 || ($# == 1 && $1 == --trust-only) ]] || die "Usage: $0 [--trust-only]"
rig_config
emulator_config
remote=/data/local/tmp/t3-mesh-rig
hash=$(openssl x509 -in "$rig/ca.crt" -noout -subject_hash_old)
fingerprint=$(openssl x509 -in "$rig/viewer.crt" -noout -fingerprint -sha256)
boot=$("${adb_cmd[@]}" shell cat /proc/sys/kernel/random/boot_id | tr -d '\r')

"${adb_cmd[@]}" root
"${adb_cmd[@]}" wait-for-device
[[ $("${adb_cmd[@]}" shell id -u | tr -d '\r') == 0 ]] ||
  die "A rootable Google APIs AVD is required (adb root failed)"
"${adb_cmd[@]}" shell mkdir -p "$remote"
"${adb_cmd[@]}" push "$rig/ca.crt" "$remote/$hash.0" >/dev/null
"${adb_cmd[@]}" shell sh -s "$hash" <<'ANDROID'
set -eu
base=/data/local/tmp/t3-mesh-rig
roots=/apex/com.android.conscrypt/cacerts
[ -d "$roots" ] || roots=/system/etc/security/cacerts
ca=$1.0
# A tmpfs copy avoids a bind mount from /data into the app's trusted CA path.
if ! grep -q " $base/cacerts " /proc/mounts; then
  mkdir -p "$base/cacerts"
  mount -t tmpfs tmpfs "$base/cacerts"
  cp "$roots"/* "$base/cacerts/"
fi
cp "$base/$ca" "$base/cacerts/$ca"
chmod 755 "$base/cacerts"
chmod 644 "$base/cacerts/"*
chcon -R u:object_r:system_file:s0 "$base/cacerts"
cat > "$base/hosts" <<'HOSTS'
127.0.0.1 localhost mesh.noqer.com hub.mesh.noqer.com t3.rig.mesh.noqer.com
::1 localhost ip6-localhost ip6-loopback
HOSTS
chmod 644 "$base/hosts"
chcon u:object_r:system_file:s0 "$base/hosts"
seen=""
for pid in 1 $(pidof zygote64 zygote system_server netd com.noqer.t3mesh); do
  namespace=$(readlink "/proc/$pid/ns/mnt") || continue
  case " $seen " in *" $namespace "*) continue ;; esac
  nsenter -t "$pid" -m -- sh -ec '
    # CA paths in newer Android images are private to the zygote namespace.
    grep -q " $2 " /proc/mounts && umount "$2" || true
    mount --bind "$1/cacerts" "$2"
    grep -q " /system/etc/hosts " /proc/mounts && umount /system/etc/hosts || true
    mount --bind "$1/hosts" /system/etc/hosts
    test -s "$2/$3"
  ' sh "$base" "$roots" "$ca"
  seen="$seen $namespace"
done
ANDROID
"${adb_cmd[@]}" reverse tcp:443 "tcp:$FRONT_PORT"

if [[ ${1:-} == --trust-only ]]; then
  exit 0
fi
stamp="$boot $fingerprint"
if [[ $("${adb_cmd[@]}" shell cat "$remote/keychain" 2>/dev/null | tr -d '\r' || true) == "$stamp" ]]; then
  echo "KeyChain identity already installed for this boot."
  exit 0
fi

"${adb_cmd[@]}" shell 'test -d /sdcard && mkdir -p /sdcard/Download && test -w /sdcard/Download' ||
  die "Unlock the emulator so Downloads is available, then rerun harness.sh"

p12="$rig/RigViewer.p12"
password=$(openssl rand -hex 8)
openssl pkcs12 -export -legacy -in "$rig/viewer.crt" -inkey "$rig/viewer.key" \
  -certfile "$rig/ca.crt" -name RigViewer -passout "pass:$password" -out "$p12"
"${adb_cmd[@]}" push "$p12" /sdcard/Download/RigViewer.p12 >/dev/null
trap '"${adb_cmd[@]}" shell rm -f /sdcard/Download/RigViewer.p12 >/dev/null 2>&1 || true' EXIT

# AgentDevice passes the action to Android's activity manager and keeps the installer in its session.
device open com.android.certinstaller --relaunch --activity .CertInstallerMain \
  --launch-args -a --launch-args android.credentials.INSTALL >/dev/null
pick_download RigViewer.p12
ui_fill 'editable=true' "$password"
ui_tap 'label="OK"'
ui_wait 'label="VPN & app user certificate" checked=true'
ui_tap 'label="OK"'
ui_wait 'label="Name this certificate"'
ui_tap 'label="OK"'
device wait absent 'label="Name this certificate"' 15000 >/dev/null
"${adb_cmd[@]}" shell "printf '%s\n' '$stamp' > '$remote/keychain'"
echo "Installed the rig CA, host mappings, reverse, and KeyChain identity."
