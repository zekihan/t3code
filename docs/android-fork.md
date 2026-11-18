# T3 Code Android fork with mTLS

Status: proposed. Date: 2026-11-17.

A personal fork of the T3 Code mobile app (`pingdotgg/t3code`, `apps/mobile`) that
connects to the mesh viewer hosts with the phone's client certificate, plus a few
mesh features served by the t3-mesh hub. It is built weekly and installed only on
the owner's own devices. It builds on the
[t3-mesh design](https://github.com/zekihan/t3-mesh/blob/main/docs/design.md), called design.md below.

## Goals

- Use the native app, not only the browser, against
  `t3.<machine>.mesh.noqer.com`, with the identity already in the Android KeyChain.
- List the mesh machines in the app without adding each one by hand.
- Keep the weekly upkeep near one hour.

## Non-goals

- Publishing to Play, F-Droid or any other store.
- Direct LAN connections with the KeyChain identity. Viewer authorization for
  that identity stays in Traefik and the hub; only the enrolled identity of item 4
  may connect directly (item 5).
- Push notifications, Clerk sign-in and the managed relay. They depend on
  upstream's cloud accounts, and T3 Connect is off on every machine.

## Background

- **No client certificates upstream.** On Android, the app's HTTP and WebSocket
  traffic go through React Native's OkHttp. Upstream has no client-certificate
  support and no maintainer response to the request (Discussion #17218).
- **Existing implementation.** nickypro's branch `feat/android-client-certificates`
  (one commit, about 2k lines with tests) adds a KeyChain-backed OkHttp socket
  factory through an Expo config plugin and native module,
  `apps/mobile/modules/t3-client-certificates`. It also covers Expo FileSystem
  attachments and Expo Video. On 2026-11-17 it was 3,874 commits behind upstream
  `main` (last rebased 2026-10-30).
- **Upstream baseline.** On 2026-11-17 upstream used Expo 58.0.23 and React Native
  0.88.1. The version comes from `T3CODE_MOBILE_VERSION`, and Expo Updates uses the
  `fingerprint` runtime-version policy.
- **Change rate.** Over 14 days upstream averaged ~213 commits a day, ~32 of them
  in `apps/mobile`. The files the mTLS commit edits saw ~25 commits in total.
- **Servers.** They run upstream nightly builds. Pairing works against the mesh
  hosts: with a one-time token from `t3 auth pairing create --base-url
  https://t3.<machine>.mesh.noqer.com` on z-mac (desktop app, local-only), and the
  normal pairing flow on z-arch and devbox.

## Fork

- **Repository.** `zekihan/t3code`, a public standalone repository holding a copy
  of upstream's history, not a GitHub fork. In a fork `gh pr create` targets the
  parent by default, so the weekly agent could open a PR on upstream; a fork also
  starts with Actions and schedules disabled and is not something homelab
  `terraform/git` creates. It is managed in `terraform/git` (GitHub only, no Forgejo
  or GitLab mirror): rebase-merge only, read-only default workflow token, a
  ruleset on `main`, and the `release` environment limited to the branch `main`.
  The mesh hostnames are already public in the t3-mesh docs.
- **Clones.** devbox, z-arch and z-mac each have the same clone at
  `~/repos/github.com/zekihan/t3code`: `origin` is `zekihan/t3code`, `upstream` is
  `pingdotgg/t3code` with pushing disabled (`pushurl = no-push`), and local `main`,
  `mesh` and `candidate` track `origin`. Upstream tags come from `upstream`; the
  fork pushes no upstream tags.
- **Branches.** `main`, the default branch, holds only the fork's workflows and docs and is
  protected. `candidate` receives each rebased stack; `mesh` is moved to a
  candidate only when its release publishes. The app's commits stay a small stack
  on top of an upstream nightly tag.
- **Upstream workflows.** A fork commit deletes upstream's `.github/workflows`, so
  pushing `candidate` runs nothing from upstream. The rebase resolves upstream edits
  to those files by deleting them again.
- **Stack layout.** Fork code lives in its own files: `modules/t3-client-certificates`,
  `src/features/mesh` and `plugins/withMesh*.cjs`. Upstream files get only small
  hook edits that call into them. One commit per concern: mTLS, app identity, CI,
  then one per mesh feature.
- **Base.** Every build rebases the stack onto the newest upstream nightly tag at
  run time, e.g. `v0.1.11-nightly.20261117.4838`, not `main`, so the app matches
  the nightly servers. Upstream tags several nightlies a day, and preview tags share
  the build counter; only `-nightly.` tags are bases. The weekly phone check against
  the deployed servers catches incompatibilities.
- **First base.** The stack starts on the nightly the servers ran when the
  repository was set up, `v0.1.11-nightly.20261117.4814` on all three machines, not
  the newest tag. The first weekly run moves it to the newest nightly.
- **Upstream.** The client-certificate support stays in the fork. Discussion #17218
  has no maintainer response; no upstream PR is planned. (PR #27889, closed, was a
  desktop Cloudflare Access change, not client certificates.)
- **First port.** Bring nickypro's commit onto a current nightly. With Expo and
  React Native upgrades in between this is a port, not a cherry-pick; budget
  1–2 days.
- **Network stacks.** nickypro's commit covers OkHttp (fetch and WebSocket), Expo
  FileSystem attachments and Expo Video. The port starts with an inventory of every
  feature that fetches from the environment: which fetcher it uses, how redirects,
  credentials and caching behave, and whether the client certificate reaches it.
  It covers the Android PDF preparation path (`preparePdfPreview`), image loading,
  video thumbnails, every `react-native-webview` surface, the Android
  `SubscriptionUsage` widget's background refresh, incoming shares, usage refresh
  and voice transcription, and records a
  disposition for each: supports the client certificate, never reaches the
  environment, or disabled in the fork.
- **WebViews.** Android caches a WebView's certificate decision per host and port
  for the whole WebView data directory, so an allowlist in
  `onReceivedClientCertRequest` cannot keep one surface from using another's
  decision. At the pinned nightly the source view and the natively downloaded PDF
  render local or inline content. The file and HTML previews loaded the signed
  environment URL directly, so the fork downloads them through the certificate
  transport and loads the local file; an MCP app on an origin with a certificate
  shows as unavailable, because its iframe cannot load a local file (see
  [network-inventory.md](network-inventory.md)). In the main process every WebView
  cancels certificate requests.
- **Stream process.** The device stream and the browser preview stream run a script
  inside the WebView that connects to the T3 server. That WebView lives in a separate
  `:stream` process with its own WebView data directory
  (`WebView.setDataDirectorySuffix`): a bound `StreamService` there owns it and draws
  it into the app's layout through `SurfaceControlViewHost` (API 30 and newer; older
  versions show the streams as unavailable), because the browser preview is embedded
  in the tablet inspector and the floating player, where an Activity cannot go.
  Commands and page messages cross a Messenger. That process answers a certificate
  request only for the environment's exact origin, with its alias, and cancels all
  others. Chromium cancels a WebSocket handshake that needs a client certificate
  before it has a decision for the origin, so each session first loads a small page
  that fetches `/.well-known/t3/environment` from the origin. Changing the alias
  kills the process. `MainApplication.onCreate` also runs in `:stream`, so it skips
  React Native, Expo and the transport there and calls `setDataDirectorySuffix`
  before anything touches WebView. This is the largest rebase surface (milestone A3).
- **Per-origin identity.** nickypro's transport stores the alias per exact origin
  and keeps OkHttp from coalescing connections across hosts; the fork keeps both.
  T3 credentials stay scoped to their environment.
- **Certificate renewal.** Device certificates renew yearly. When the stored
  KeyChain alias is missing, the app asks for the identity again. When the chosen
  certificate has less than 30 days left (read with `KeyChain.getCertificateChain`),
  the connection screen shows a warning. When an alias is replaced or removed, the
  app keeps nickypro's closing of active sockets and cancelling of transfers, evicts
  pooled OkHttp connections, and restarts the stream process.
- **Local network permission.** Android 17 requires a runtime local-network
  permission for apps targeting SDK 37 or newer, which covers the Traefik VIP at
  home and item 5. A1 checks upstream's `targetSdkVersion`; a bump to 37 is
  treated as a breaking change and tested on both devices before publishing.
- **Separate app.** Application ID `com.noqer.t3mesh`, its own URL scheme and app
  name, so it installs next to the official app.
- **Upstream accounts off.** Mostly build settings: `T3CODE_MOBILE_UPDATES_ENABLED=0`,
  `T3CODE_RELAY_URL` unset (Observe then points at `observe.invalid`), no Clerk keys
  and no `T3CODE_ANDROID_GOOGLE_SERVICES_FILE`. OTLP tracing defaults to
  `https://api.axiom.co/v1/traces`, so the build sets no traces token and the
  plugin clears the URL. The fork's config plugin also removes `updates.url`,
  `owner`, the `app.t3.codes` verified intent filter and the `expo-notifications`
  and Clerk plugins. `extra.eas.projectId` becomes a nil UUID rather than being
  removed: expo-observe's native module refuses to start without one, which kills
  app start-up.
- **Client factory owner.** expo-app-metrics (pulled in by expo-observe) replaces
  React Native's `OkHttpClientFactory` from Expo's lifecycle dispatcher, after the
  transport installs its own, which silently drops the client certificate. The
  transport takes the factory back at the end of `MainApplication.onCreate`,
  wrapping the replacement so its interceptors stay. A rebase that adds another
  library doing this is caught only on a device, so the weekly phone check pairs
  against an mTLS host.
- **Network security config.** Upstream trusts user CAs and allows cleartext for
  every host. The fork adds a `domain-config` for `mesh.noqer.com` and its
  subdomains with system trust anchors only and no cleartext.
- **No over-the-air updates.** An upstream JavaScript bundle must never replace the
  fork's code.

## Mesh features

### 1. Machine list (first)

- **New host.** `hub.mesh.noqer.com` serves `GET /api/v1/machines`. `mesh.noqer.com`
  is TLS passthrough to the agent listener and must stay agent-only.
- **Route.** The host gets its own Traefik `IngressRoute` on the viewer routes'
  entrypoints, with the `mtls-clients` TLS option, the `traefik-mtls-authz`
  middleware and a `mesh-hub` policy entry listing device identities only. It also
  needs its own certificate, a public DNS record and LAN A and AAAA records in the
  Technitium `mesh.noqer.com` zone (`terraform/technitium/mesh_dns.tf`); without the
  LAN record the host is NXDOMAIN at home.
- **Chart tests.** The current `platform/t3-mesh` tests count IngressRoutes against
  the viewer targets and derive each middleware as `mesh-<label>-<label>`, so this
  host breaks them. They gain an explicit case for it: the route exists once, uses
  `mtls-clients` and the authz middleware with the `mesh-hub` policy. They are not
  relaxed.
- **Hub dispatch.** The hub's viewer listener matches `hub.mesh.noqer.com` before
  `HostTarget`, which only splits `<svc>.<machine>.<domain>` and would answer 404.
- **Deploy order.** The hub parses its config with unknown fields rejected, so the
  hub release that understands `api.identities` ships first and the chart change
  after it. Rolling the hub back past that release requires reverting the chart
  first. The Gatus `canary-unauthorized` check gains `hub.mesh.noqer.com`: the
  canary presents a valid identity outside `mesh-hub` and expects 403. The chart
  renders `api.identities` from the `mesh-hub` policy entry, so the Traefik policy
  and the hub list cannot drift; the Technitium record name is kept in step with the
  chart's `hubApi.host` by hand.
- **API admission.** The hub config's rule map accepts only
  `mesh-<svc>-<machine>` entries, so the `mesh-hub` identities are a separate
  `api.identities` field, never a rule. The hub requires the same `X-Mtls-Mesh-*`
  headers as viewer streams and applies disabled identities and blocked leaves.
- **Filtering.** The hub returns only the machines whose `mesh-t3-<machine>` entry
  lists the caller, with name, online, last seen and viewer URL. Every `/api/v1`
  endpoint applies the same filter. An admitted caller listed on no machine gets an
  empty list, not an error. "Online" means a live tunnel session, not that T3 on the
  machine is healthy, and the app labels it that way.
- **Shipped.** Hub v0.1.13 (2026-11-18), homelab #140 and #141, app release
  `+mesh.3`; paired on the phone with all three machines.
- **App.** A "Mesh" screen lists the machines. An entry opens or pairs the
  environment at its viewer URL. Pairing itself stays manual: T3 pairing is the
  second lock and the hub never pairs on the user's behalf.
- **One identity for mesh hosts.** Opening the Mesh screen the first time asks
  for the identity for `hub.mesh.noqer.com`. That alias is then reused for the
  machines' viewer hosts, but only for URLs exactly equal to
  `https://t3.<machine>.mesh.noqer.com` for a listed machine; any other URL the hub
  returns is ignored. Any other host, including previews, still shows the picker.
  Android still asks once per alias, including after a renewal.

### 2. Fleet status

`GET /api/v1/fleet` on the same host returns agent versions, certificate expiry,
tunnel uptime and alert state from the hub's `/status`, filtered per machine like
the machine list. It is a read-only screen.

Each environment's connection details show two independent paths and a round-trip
time:

- the machine's tunnel path (LAN or OCI) and state, from the hub's tunnel state;
- the phone's hub-request path, from that API request's `X-Real-IP`, which the
  `traefik-real-ip` middleware sets on both entrypoints, checked against
  `homeCIDRs`. The connection's own peer is a Traefik pod and says nothing. It is labelled as the path of
  the hub request: split DNS, a network change or a pooled connection can put the
  viewer WebSocket on a different path;
- the round-trip time of that same API request.

### 3. Dev-server previews (after upstream PR #38045)

- **Upstream tunnel.** Upstream PR #38045 (open on 2026-11-17) renders a dev
  server's page in the phone's own WebView at its original `localhost` origin. A
  SOCKS listener in the app carries each connection as a WebSocket to the server's
  `/api/preview/tunnel`, over the connection the app already has. The fork adopts
  it once it is in a nightly the machines run. No preview DNS, certificates, routes
  or policy entries are added.
- **Fork work.** The tunnel WebSocket goes through the app's mTLS OkHttp client.
  The preview WebView gets no client certificate, no T3 token and no foreign native
  bridge.
- **Proxy scope.** On Android the PR uses `ProxyController.setProxyOverride`, which
  applies to every WebView in the process, and sets it only while the preview is
  attached. The fork keeps it in the main process only, never in the `:stream`
  process, and checks that the source, PDF and HTML WebViews still work while a
  preview is open.
- **Listener exposure.** The PR's SOCKS listener on `127.0.0.1` takes no
  credentials, and Android loopback is shared by all apps; a normal app cannot
  tell which app owns a loopback connection, and the WebView proxy override cannot
  send SOCKS credentials. A fork patch limits the listener to `localhost`,
  `127.0.0.1` and `::1` on the active preview's port and opens it only while the
  preview is attached. The proxy override uses a reverse bypass, so only that
  origin is proxied and other main-process WebViews keep loading remote content. Accepted
  risk: during that time another app on the device can reach that one dev-server
  port through the owner's T3 connection.

### 4. Device enrollment with a Keystore key (last)

- **Key.** The app creates a non-exportable key in the Android Keystore and sends a
  CSR with a one-time token, as agents enroll.
- **Bootstrap.** Enrollment uses the existing `t3-mesh-enroll/1` ALPN on
  `mesh.noqer.com`, the only path open to a client without a certificate. The app
  verifies the hub's Let's Encrypt certificate with system roots and the exact
  hostname. Tokens stay bound to one identity, single-use and 15 minutes, as for
  agents. `enroll-token --device <identity>` accepts only an identity of the
  enrolled-device kind and refuses `agent-*` and every other kind. Today
  `EnrollAllowed` admits only agent identities, so it gains the device kind. The
  reply carries the leaf, chain and the clients CA bundle with its revision.
- **Separate identities.** Each device gets its own identity in a namespace distinct
  from the existing device identities: `device-z-phone-mesh` and
  `device-z-tablet-mesh`, so one device's renewal never supersedes the other's.
  They appear only in `mesh-*` policy entries. This way a compromised hub that can
  mint them reaches the mesh viewers, which it already proxies, and nothing else. It
  must never be able to mint `z-phone`, which every app policy trusts.
- **Use.** Once enrolled, the app uses the enrolled identity for every mesh host:
  viewer hosts, `hub.mesh.noqer.com` and direct access. The KeyChain identity is no
  longer sent to mesh hosts. nickypro's transport loads keys only through
  `KeyChain.getPrivateKey`; the OkHttp identity factory and the `:stream` process
  gain an Android Keystore key source and never call `KeyChain` for a mesh origin
  after enrollment. The key is created with `DIGEST_NONE` as well as `SHA-256`,
  because Conscrypt and Chromium sign TLS handshakes with `NONEwithECDSA`. Whether
  Chromium's `ClientCertRequest.proceed` signs with a Keystore key is checked first
  in A7.
- **Approver-policy.** A second CertificateRequestPolicy for the hub's
  ServiceAccount allows only the enumerated device URIs (no wildcard), usages
  `client auth` and `digital signature` (no `server auth`), ECDSA P-256 and 8760h,
  selecting the same clients Issuer and namespace as the agent policy. The hub's
  issuer requests usages by kind; today it always asks for `server auth`, which this
  policy would deny.
  The hub's ClusterRole gains `use` on this policy by name (`resourceNames`), and
  the render tests that expect exactly one policy and check the role learn about
  the second.
  The agent policy stays unchanged. approver-policy approves a request only when
  one policy allows all of it, so a request mixing agent and device URIs is denied
  by both. The same ServiceAccount is used: a second one in the same pod would be
  equally available to a compromised hub. The hub still enforces exactly one URI.
- **Homelab.** `libs/mtls-policy` gains a kind for enrolled devices. A chart test
  fails when any entry other than `mesh-*` lists one.
- **Renewal.** The app renews with 90 days left through `hub.mesh.noqer.com`,
  authenticated by its current leaf, with a new key.
- **Newest leaf.** The hub admits only the newest issued leaf of an enrolled
  identity on viewer hosts and the API, using the fingerprint header. As with
  agents, a renewal whose reply is lost leaves the device with a superseded leaf;
  the recovery is re-enrollment with a new token.
- **Leaves on agents.** The hub sends agents the newest fingerprint of each
  enrolled identity, and agents accept only the newest one they know. A
  re-enrolled device's old leaf is therefore refused at once, as design.md requires
  for agents.
- **Overlap on the device.** A machine that slept through a renewal and then lost
  the hub still knows the old fingerprint as the newest. So the device keeps its previous Keystore
  key and certificate for 1 week after renewal (the agents' cache window), for the
  direct path only, and retries the direct path with it when the new leaf is
  refused. A machine that missed the renewal for longer has an expired cache
  anyway. After the week, or at once when the old leaf is blocked, the device
  deletes the old key. Re-enrollment deletes the old key immediately.

### 5. Direct connection at home (after item 4)

At home the phone already stays on the LAN (Technitium answers the viewer hosts
with the Traefik VIP), but every request still crosses the cluster, so a cluster
outage cuts the phone off. This item lets an enrolled device reach a home machine
directly.

- **Admission.** The client certificate must carry exactly one URI, of the
  enrolled-device kind, listed in that machine's `mesh-t3-<machine>` entry, not
  disabled or blocked, and its fingerprint must be the newest this agent knows for
  that identity (see item 4). The KeyChain identity never connects directly.
- **Agent listener.** A new TLS 1.3 mTLS HTTP and WebSocket listener per agent on
  its own configured port (e.g. 27443, below the ephemeral ranges like the other
  agent ports, so the unprivileged `t3mesh` user can bind it), proxying to
  `127.0.0.1:3773`. It is separate from the `t3-mesh-direct/1` listener. It offers
  ALPN `http/1.1` only, because the viewer path reaches T3 as HTTP/1.1. It binds
  under the same home gate as the direct listener: only while the hub marks the
  machine home, and during a hub outage only while the cached home gateway MAC
  matches.
- **Origin.** The viewer host stays T3's logical origin. The listener accepts only
  `Host: t3.<machine>.mesh.noqer.com` for its own machine and forwards it
  unchanged, like the hub's viewer proxy. It strips client-sent `X-Mtls-*`,
  `Forwarded` and `X-Forwarded-*` headers, sets `X-Forwarded-Proto: https` and adds
  no `X-Forwarded-For`, matching the hub.
  Unpaired HTTP and WebSocket requests must get exactly what they get through the
  viewer host.
- **Live sessions.** Open HTTP keep-alive connections and WebSockets close at once
  on revocation, rule removal, a superseded leaf, leaf expiry, or the end of the
  cache window.
- **Outage.** Cached rules and fingerprints allow direct device access for up to
  1 week without the hub, the same `cacheTTL` as between machines. A revocation
  made during an outage takes effect when the agent next reaches the hub.
- **Server trust.** Before sending T3 credentials, the app checks the agent's
  certificate against the cached clients CA bundle: `server auth` usage, exactly
  one URI equal to the expected `agent-<machine>`, and its leaf not in the cached
  revocation list. No hostname check.
- **Trust refresh.** `GET /api/v1/trust` on `hub.mesh.noqer.com` returns the CA
  bundle with its revision and the agent revocations. The app refreshes it on every
  hub contact and persists it; after 1 week without a refresh the direct path is
  off. A CA rotation therefore reaches the phone like it reaches agents.
- **Route.** The machine list carries each machine's LAN address and direct port
  while it is home. The app persists them and the expected agent identity for up to
  1 week, so a cold start works without the hub.
- **Home gate.** The app tries the direct path only when the hub's `X-Real-IP`
  check says the phone is home. Without the hub it probes once per network change
  and caches a failure for 60 s, as agents do, so away from home it does not wait
  on a cached `192.168.x` address before every connection.
- **Direct dial.** The environment keeps its single viewer URL, so the request URL,
  `Host`, `Origin`, cookies and T3 credentials are unchanged. An in-app loopback
  CONNECT proxy turns `CONNECT t3.<machine>.mesh.noqer.com:443` into a TCP
  connection to the machine's LAN address and direct port, and relays nothing
  else. TLS stays end to end between the app and the agent.
  - **OkHttp:** a direct client uses that proxy and a trust manager that accepts
    only the agent check above, in place of system trust and hostname
    verification.
  - **Streams:** the device stream document's origin is `https://localhost/` on
    Android, so its connections to the environment are cross-origin; A8 starts by
    checking that `onReceivedSslError` and `onReceivedClientCertRequest` fire for
    them. The `:stream` process sets `ProxyController.setProxyOverride` to
    the same proxy for the direct attempt. For stream connections the proxy first
    completes its own native TLS handshake with the peer and runs the agent check,
    then relays the WebView's connection to the same address. In
    `onReceivedSslError` the WebView proceeds only when the presented certificate
    passes the same agent check, and it clears that decision when the path
    changes. WebView calls that hook only when its own validation fails, so a peer
    with a publicly valid viewer certificate (only the cluster has one, and it
    enforces viewer policy) is accepted without it. Accepted: the stream may then
    be labelled direct while going through the cluster.
  - **Path selection:** the app picks the path with a side-effect-free probe
    (`GET /.well-known/t3-mesh/direct`, answered by the agent itself), with 2 s for
    TCP and TLS and 5 s for the response, and falls back to the viewer host when
    it fails. A certificate or authorization failure on the direct path is shown
    even when the fallback works.
  - **No replays:** once a request has been sent on a path, the app retries it on
    the other path only if it is replay-safe (`GET`, `HEAD`, or opening a
    WebSocket). Any other request that may have reached T3 is reported as having
    an unknown outcome, never repeated automatically.

  This touches upstream's connection code, the main source of rebase conflicts.

## Build and distribution

- **Workflow source.** Every workflow runs from its definition on the protected
  `main`. The `release` environment's deployment policy is the branch `main`, not
  the `v*` tag pattern the t3-mesh repository uses. Nothing on `candidate` or
  `mesh` can reach the signing key. The repository's default `GITHUB_TOKEN` is
  read-only. A2 tests that a workflow added on `candidate` cannot read the key.
- **Release workflow.** One workflow on `main`, dispatched with a `candidate`
  commit as input, under a workflow-level `release` concurrency group shared with
  rollback, so version assignment and publishing are serialized. It has two jobs:
  - **build** (`permissions: contents: read`, no secrets, because it runs freshly
    fetched upstream and dependency code): checks out the commit, runs the mobile
    tests (JavaScript and the module's Kotlin unit tests; no emulator test,
    because installing a KeyChain identity needs the UI), then `expo prebuild`
    and `./gradlew assembleRelease` for `arm64-v8a` only (Galaxy S24 Ultra and
    Galaxy Tab S9 FE+), unsigned. It reads the highest published `versionCode`,
    pre-releases included, and bakes `max(formula, last + 1)` into the APK through
    the config plugin, because upstream has no `android.versionCode` (EAS assigns
    it remotely).
  - **release** (`needs: build`, `environment: release`, `contents: write`):
    restores no caches and checks out no candidate code; it treats the APK
    artifact as hostile input. It drops the run when `candidate` no longer points
    at the input commit. It signs with `apksigner` from build tools pinned on
    `main`, reads the APK's fields only with those tools, validates each by regex
    before use, and checks: application ID `com.noqer.t3mesh`, the expected
    signing certificate fingerprint, `versionName`, `versionCode`, the intent
    filters, and Expo Updates disabled in the manifest. It refuses a
    `versionCode` at or below the highest published one, then creates the tag on
    the existing commit and publishes the release.
- **Target SDK hold.** The release job compares the APK's `targetSdkVersion` with
  the last release that is not a pre-release. When it changed, the release is
  published as a pre-release, which Obtainium is configured to ignore, and
  reported; the owner promotes it after the device check in Fork.
- **Rollback.** A manual dispatch of the same two-job shape on `main` takes the
  last good release tag and rebuilds that commit without secrets, with the
  toolchain versions recorded for it in a file on `main` (never read from an
  artifact), the next `versionCode` and a `.rollback` suffix on `versionName`; the
  release job signs and publishes it. Android and Obtainium install only a higher
  `versionCode`, so republishing the old APK would not work. Release tags keep old
  commits reachable after force-pushes. A rollback can meet app state migrated by
  the bad release; A2 tests an update, a rollback and a forward update over a
  paired installation on both devices.
- **Branch moves.** The workflows never push branches: upstream commits edit
  `.github/workflows`, and GitHub may refuse such ref updates from `GITHUB_TOKEN`.
  The weekly task moves `mesh` to the newest published release tag with devbox's
  key. A2 checks that tag creation works on a base whose upstream commits changed
  workflows.
- **Signing key.** It lives in the secrets repo and is published to the fork's
  `release` environment by homelab `terraform/git`, like the t3-mesh minisign key.
  Losing it means reinstalling and re-pairing, so it is backed up.
- **Accepted risk.** Clean rebases publish without review. A compromised upstream
  or dependency change reaches both devices, signed, within a week.
- **Distribution.** Each build is a GitHub Release on the fork with the signed APK.
  Obtainium on each device tracks those releases and installs updates; Android
  refuses an update signed with a different key. No index, index key or hosting.
  The release tag is `v` followed by the `versionName`, so Obtainium's version
  detection can compare them; it offers any release whose tag differs from the
  installed version, which also covers a rollback naming an older nightly. A2
  verifies both.
  The APK contains no secrets, but anyone can read the mesh hostnames from it.
- **Sideload check.** Before A2, confirm that Google's developer verification does
  not block Obtainium installs on the devices. `adb install -r` is the fallback.

## Versioning

| Field | Format | Example |
|---|---|---|
| `versionName` | `<nightly>+mesh.<rev>` | `0.1.11-nightly.20261117.4838+mesh.1` |
| `versionCode` | `max(<nightly build number> × 100 + <rev>, <last published> + 1)` | `483801` |
| Git tag | `v<versionName>` | `v0.1.11-nightly.20261117.4838+mesh.1` |

- Expo's `version` stays upstream's mobile version (e.g. `2.3.0`), because the app
  sends it to the server in its auth client metadata. The fork's config plugin sets
  `versionName` and `versionCode`; upstream takes `versionCode` from EAS, so a local
  Gradle build would otherwise get 1.
- `rev` restarts at 1 on each new upstream base and stays between 1 and 99.
- The upstream build number only increases, so `versionCode` normally follows the
  formula; the `max` matters only after a rollback, whose old base would otherwise
  get a lower code. A rollback's `versionName` is e.g.
  `0.1.11-nightly.20261117.4825+mesh.3.rollback`.
- Hub endpoints are versioned (`/api/v1/...`) independently of t3-mesh releases.

## Weekly upkeep

- **Automation.** A weekly T3 scheduled task on devbox first moves `mesh` to the
  newest published release tag. If `candidate` is ahead of `mesh` with no open PR
  and no release for its tip (a merged fix whose build never ran), it dispatches a
  build for it and rebases from `candidate`; otherwise from `mesh`. It rebases onto
  the newest nightly, force-pushes `candidate` with devbox's existing SSH key and
  dispatches the release workflow. The clean path runs no upstream code on devbox.
- **Daily check.** A scheduled workflow on `main` runs the same "candidate ahead
  with no release" check every day and dispatches the build, so a merged fix does
  not wait for the weekly run or depend on an agent thread.
- **Conflicts and failures.** A rebase conflict or a failed build goes to the
  task's agent. For a failed build it branches from `candidate`. For a conflict
  the task first force-pushes `candidate` to the new nightly with the stack commits
  that applied cleanly, so the PR's base is the new nightly; the agent's branch
  adds the remaining commits, resolved. It runs the tests and opens a PR into
  `candidate`, merged with rebase-merge so the stack stays separate commits.
  Nothing publishes until the owner merges, and `mesh` and the previous release
  stay where they were. A merge into `candidate` triggers no workflow; the daily
  check dispatches its build.
- **Reporting.** Details stay in the task's T3 thread; the PR or a failure issue on
  the fork arrives through GitHub notifications.
- **Open fixes.** While a fix PR into `candidate` is open, the weekly task does not
  rebase or force-push `candidate`; it reports instead.
- **Accepted risk.** devbox's SSH key can push to every repository and is a
  repository admin, which bypasses the ruleset on `main`. The agent runs upstream
  install and test scripts on devbox when fixing a failure. A compromised upstream
  change met during a fix could push a workflow to `main`, read the APK signing key
  through the `release` environment and sign every future APK.
- **Normal week.** A clean rebase, then a 10–15 minute phone check against all
  three machines on their deployed server versions: pair, chat, reconnect, an
  attachment and the Mesh screen.
- **Bad week.** Conflicts concentrate in `features/connection` and `app.config.ts`.
  An Expo or React Native upgrade that breaks the native module costs half a day to
  a day every month or two.
- **Exit.** No fixed rule; whether to keep the fork is decided case by case. The
  browser on the mesh hosts remains the fallback.

## Milestones

| | Scope | Done when |
|---|---|---|
| A1 | Fork, port of the mTLS commit, network inventory, WebView rule (streams disabled), per-origin identity, app identity, accounts off, network security config, expiry warning; local build installed with `adb` | Every inventoried feature has a disposition, and each supported one works against z-arch over `t3.z-arch.mesh.noqer.com` with the KeyChain identity: pair, chat, reconnect, attachment upload and download, PDF preparation, images, video and thumbnails, the widget refresh, and each WebView surface; the app survives a cold start; a main-process WebView loading a viewer host gets no certificate; replacing the alias while a WebSocket is open moves it to the new identity without an app restart; a short-lived test certificate shows the warning |
| A2 | `main` workflows, build and release workflows, GitHub Releases, Obtainium | Both devices install the fork through Obtainium from a CI release and update over a paired installation; update, rollback and forward update work on both; the release checks pass; a simulated `targetSdkVersion` bump is held as a pre-release that Obtainium does not offer; a workflow added on `candidate` cannot read the signing key; one rebase conflict and one CI failure each go through a PR to a published release; a fix merged with no build is built by the daily check and not overwritten by the next weekly run; a release whose base changed upstream workflows is tagged and published; Obtainium offers a release and a rollback by tag; the A1 checks pass on that build on both devices |
| A3 | Stream process for the device and browser preview streams | Both streams work against z-arch with the KeyChain identity; a main-process WebView loading a viewer host still gets no certificate after a stream has used it; replacing the alias while a stream is open moves it to the new identity; the stream process skips React Native start-up |
| A4 | Item 1: `hub.mesh.noqer.com`, `/api/v1/machines`, the Mesh screen and one identity for mesh hosts | A fresh install opens the Mesh screen before any pairing, at home and on mobile data, and lists all three machines with online state; a viewer missing from one machine's policy does not see it in any `/api/v1` endpoint; a valid but unauthorized client with forged `X-Mtls-*` headers and a blocked leaf are refused; a second listed machine is added without a picker, and an unlisted mesh host still shows it |
| A5 | Item 2: fleet screen and connection details | Versions, certificate expiry, tunnel uptime and alert state match `/status` for the machines the caller may see; on mobile data the hub-request path shows OCI while z-mac's tunnel at home shows LAN, both show LAN with the phone at home, and a network change updates the path; the round-trip time is shown |
| A6 | Item 3: upstream's localhost preview tunnel through the fork, once PR #38045 is in a nightly the machines run | A Vite dev server on z-arch opens on the phone at its `localhost` origin with assets and HMR live reload, home and away; from a separate test app on the device, the SOCKS listener refuses any port other than the preview's and is closed once the preview is detached; the tunnel WebSocket uses the mTLS client; the preview WebView receives no T3 token, no client certificate and no foreign native bridge; the source, PDF and HTML WebViews work while the preview is open, and the streams are unaffected |
| A7 | Item 4: Keystore enrollment | Both devices enroll with tokens under the deployed policy, their keys are non-exportable, their identities reach only `mesh-*` hosts and replace the KeyChain identity there, the hub logs the enrolled URI for both a chat socket and a stream, and a forced renewal works; a token for one device cannot enroll the other; a wrong-kind token, a replayed token and a disabled identity are refused; a superseded leaf is refused on viewer hosts and the API; a lost renewal reply recovers by re-enrollment, after which the old leaf is refused on the direct path at once; the renewal endpoint refuses a KeyChain identity; requests from the hub ServiceAccount are denied for `z-phone`, for agent and device URIs together, for a device with `server auth`, with an extra DNS SAN, and with `isCA` |
| A8 | Item 5: direct connection at home | With the hub scaled to zero, the phone at home chats with z-arch directly and opens a device stream there, also after a cold start; a device renewed while z-mac stayed disconnected from before the renewal until after the hub was scaled to zero still reaches z-mac directly with its previous leaf; a direct server that performs a POST and withholds its response causes no second execution through the viewer host; away it uses the viewer host and makes no direct attempt; the previous key is deleted a week after renewal; a stalled TLS handshake and a peer that completes TLS but never answers both fall back within the deadlines; unpaired HTTP and WebSocket requests on the direct path match the viewer host; blocking the enrolled leaf, removing the device from the rule, a superseded leaf, leaf expiry and cache expiry each close an open WebSocket or refuse the session; an enrolled device not in the rule, the KeyChain identity and a wrong `Host` are refused; the app refuses an agent with the wrong identity or a blocked leaf; a CA rotation reaches the phone; an agent on a foreign network matching `homeCIDRs` during a hub outage does not open the listener (integration test, as in M3) |

## Open decisions

- Whether to do item 4 at all, given the approver-policy widening it needs. Decided
  after A5. Item 5 depends on it.
- Whether to do item 5, depending on how often the cluster is down while home.
