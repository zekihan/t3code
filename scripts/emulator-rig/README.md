# Mesh Android emulator rig

Use a disposable, English-language, rootable x86_64 Google APIs AVD. The rig was
built for `Pixel_8_API_37` (Android 17). The weekly check clears
`com.noqer.t3mesh` app data on that AVD before pairing. It writes screenshots,
UI output on failure, and direct-path evidence to a private output directory.
The reconnect check verifies that the composer resumes sending and saves the
message recorded by T3.

## Build and run

Use the versions from the fork's release workflow. Prepare a separate candidate
checkout or extract the app stack with `git archive origin/candidate`; the
default branch contains only the fork's operational files. Stop the AVD before
running Gradle, including incremental builds. `adb emu kill` preserves app data.

```bash
# In the extracted candidate root with the release toolchain configured (JDK 17).
pnpm install --frozen-lockfile
export APP_VARIANT=production T3CODE_MOBILE_UPDATES_ENABLED=0 EXPO_NO_GIT_STATUS=1 CI=1
export T3MESH_VERSION_NAME=0.1.12-nightly.20261121.5051+mesh.99 T3MESH_VERSION_CODE=505199
cd apps/mobile
pnpm exec expo prebuild --clean --platform android --no-install
cd android
nice -n 19 ./gradlew --max-workers=6 --no-daemon assembleRelease -PreactNativeArchitectures=x86_64
```

Use a version name and code from the nightly under test. The APK is under
`apps/mobile/android/app/build/outputs/apk/release/`. For a faster local APK,
Gradle also accepts `-Pandroid.enableMinifyInReleaseBuilds=false` and
`-Pandroid.enableShrinkResourcesInReleaseBuilds=false`. The result exercises
the candidate runtime without exercising release shrinking.

From the fork's default-branch checkout, start the rig in a dedicated terminal.

```bash
scripts/emulator-rig/run.sh
```

The host needs Git, Go (as specified in the pinned mesh module), Caddy 2 with
`trust_pool file` support, T3 Code, Node, curl, jq, OpenSSL and ADB. Set
`T3_MESH_REPO` if the mesh checkout is elsewhere, `T3_MESH_REF` to test another
local mesh commit, `T3_CANDIDATE_REF` if the replay fixture is on a different
local ref, and `T3_BIN` for a matching T3 nightly. The rig archives the mesh
revision into scratch, then vets and builds its Go command inside that module.
It uses the candidate's upstream ACP replay agent for cost-free chat. Set
`T3_RIG_LAN_IP` if the host's default route does not use the private IPv4 the
emulator can reach. `T3_RIG_SERVER_PORT` and `T3_RIG_CADDY_PORT` can override
the default loopback ports, 38773 and 8443.

After the APK build exits, open the AVD through T3 Code's Device panel. Unlock
the emulator after a cold boot if it has a screen lock. Use the AgentDevice command and target arguments returned for that session. Put each
target argument on its own line in a private file. Use the same AVD for the
Android tools and the panel.

```bash
export T3_RIG_DIR=/tmp/t3-mesh-rig.REPLACE
export AGENT_DEVICE=/path/to/agent-device
export T3_RIG_DEVICE_ARGS=/path/to/private/device-args.txt
# Optional when multiple AVDs are running.
# export ANDROID_SERIAL=emulator-5554
scripts/emulator-rig/harness.sh
scripts/emulator-rig/weekly-check.sh /absolute/path/to/app-release.apk
```

`harness.sh` configures the system CA, hosts and `adb reverse tcp:443`, then
opens Android's credential installer to import a test PKCS#12. Use
`harness.sh --trust-only` to refresh just the mounts and reverse. When choosing
the identity in the app, tap the `cert_item_selected` radio and then Select. The
label can appear to respond without selecting the cert. The p12 uses
`openssl pkcs12 -legacy` for Android compatibility.

`ui.sh dump` prints the UI hierarchy. `ui.sh text 'Pair rig'` and
`ui.sh id com.android.keychain:id/cert_item_selected` tap an exact label or
resource ID. `shot.sh /path/to/screenshot.png` captures the current screen.
`T3_RIG_OUTPUT` overrides the separate output directory.

## Test topology and reset

Enrollment uses `mesh.noqer.com` and the real hub tunnel listener. The API at
`hub.mesh.noqer.com` and viewer at `t3.rig.mesh.noqer.com` require client
certificates and call the real viewer handler. The front sniffs SNI without
writing the sniff handshake's TLS alert to the client. The agent proxies to an
isolated T3 backend behind Caddy's mTLS listener. The test CA is installed in
the system trust store and the HTTPS front’s server certificate is valid for 90 days.
Long-lived server certificates can fail in Android WebView with error -213.
The mesh agent’s identity leaf has a 120-day term to stay outside its 90-day
renewal window.

The direct listener binds a random port on the host LAN IP. The emulator
reaches it through slirp NAT. `10.0.2.2` denotes host loopback, and the app's
direct route requires a private LAN address from the hub. The rig supplies a
fixed test gateway MAC and marks the rig client as at home.

The local control URL is printed by `run.sh`. Append `/hub?up=0&mode=503` to
drop current front connections and return HTTP 503 to new viewer and API
requests after TLS. `/hub?up=1` restores the relay. `/front/kill` just drops
front connections. The weekly check restores the hub when it exits. The
rig also supports `mode=drop` to close new connections before TLS completes.

Stop `run.sh` with Ctrl-C. For a fresh run, use a new scratch directory and
reboot the disposable AVD to remove the bind mounts. Rerun the harness after
every reboot for the CA, hosts, reverse, and KeyChain identity. To test a rig
restart with an existing enrolled app, reuse the same scratch directory and
set `A8_SEED=device-rig-mesh=<leaf SHA-256>` from the previous
`Certificate issued` line in `logs/mesh.log`. The fixture issuer keeps its
newest-leaf map in memory. A repeated weekly check pairs and enrolls afresh.

## Still manual on the phone

- Obtainium installation and signed update or rollback over a paired release.
  The locally signed APK exercises the candidate's native and JS bundle.
- Pairing and reconnect against the real fleet, mobile-data or LAN transitions,
  and the deployed hub's certificate and enrollment policy. The rig uses one
  isolated machine on a simulated home path.
- Device and browser streams, playback, document previews, and the complete
  attachment and certificate-renewal matrix. The weekly run uploads one file,
  enrolls once, and checks a direct chat after a cold app start.
- Hardware Keystore behavior and physical-device permission or OEM dialogs.
