# Network inventory (milestone A1)

Every path in the mobile app that can reach a paired environment, and what it does when
the environment's origin has a selected client certificate. Paths are relative to
`apps/mobile` in the `stack/a1` patch stack unless they start with `node_modules/` (the
pinned nightly's dependencies) or `packages/`.

Dispositions:

- **supports**: the request presents the client certificate.
- **never reaches**: no request can reach the environment from this path.
- **disabled**: the fork turns the feature off on Android for an origin that needs a certificate (or entirely).

All Android native transports that present the certificate share one process-wide OkHttp
configuration (`T3CertificateTransport.install`, run in `MainApplication.onCreate` right after
`super.onCreate()`; `plugins/withAndroidClientCertificates.cjs`). A fetcher is "covered" when
it builds its client from `OkHttpClientProvider`. Fetchers that build a private
`OkHttpClient`, `HttpURLConnection` or WebView cannot be covered, so they are either routed
through `transferWithClientCertificate` (a native streaming download into an app-owned file,
`src/lib/clientCertificates.android.ts`) or kept away from environment URLs.

## Covered by the shared transport

| Feature | Fetcher | Disposition | Evidence |
| --- | --- | --- | --- |
| API calls, orchestration RPC over HTTP, asset ticket minting, pairing | React Native `fetch` / `XMLHttpRequest` (`NetworkingModule`) | supports | `modules/t3-client-certificates/android/src/main/java/expo/modules/t3clientcertificates/T3CertificateTransport.kt:73` (`NetworkingModule.setCustomClientBuilder`) |
| Live environment connection | React Native `WebSocket` (`WebSocketModule`) | supports | `T3CertificateTransport.kt:74` |
| Voice transcription upload, ZIP archive reads, SVG markdown images, attachment text documents | `expo/fetch` (`ExpoFetchModule`) | supports | `node_modules/expo/android/src/main/java/expo/modules/fetch/ExpoFetchModule.kt:27` builds from `OkHttpClientProvider`; callers `src/features/voice-input/voiceDestination.ts:129`, `src/features/files/ZipArchiveView.tsx:202`, `src/features/threads/ThreadMarkdownImage.tsx:54`, `src/lib/attachmentDocument.ts:51` |
| `Image` from React Native (image viewer, avatars) | Fresco | supports | `T3CertificateTransport.kt:66-69` replaces the `OkHttpClientProvider` factory that Fresco's pipeline reads |
| Project favicons, block markdown images, thread image attachments, file previews | `expo-image` (Glide) | supports | `node_modules/expo-image/android/src/main/java/expo/modules/image/okhttp/ExpoImageOkHttpClientGlideModule.kt:80` (`OkHttpClientProvider.createClient`); users `src/components/ProjectFavicon.tsx:199`, `src/features/threads/ThreadMarkdownImage.tsx:237` |
| Attachment upload | `transferWithClientCertificate` (upload), else Expo file upload | supports | `src/lib/attachmentUpload.ts:236` |
| Attachment open/share download | `transferWithClientCertificate`; `File.downloadFileAsync` only when no certificate is selected | supports | `src/lib/attachmentDownload.ts:184-190` |
| PDF preview (`preparePdfPreview`, Android `PdfPreview` and `FilePreviewModal`) | `downloadAttachmentForPreview`, then a local file read by `react-native-pdf-jsi` | supports | `src/lib/pdfPreview.ts:26-31`, `src/lib/attachmentDownload.ts:224`, `src/components/PdfPreview.android.tsx:22` |
| Video playback | Expo Video builds a private `OkHttpClient.Builder`; the fork plays a leased local file instead | supports | `node_modules/expo-video/android/src/main/java/expo/modules/video/utils/DataSourceUtils.kt:46`; lease at `src/components/MediaVideoPlayer.tsx:79`, `src/lib/certificateMedia.ts` |
| Video thumbnails | Expo Video `generateThumbnailsAsync` over a leased local file | supports | `src/components/MediaVideoPlayer.tsx:187`, `src/components/VideoThumbnailImage.tsx:28` |

## Closed in A1

| Feature | Fetcher | Disposition | Evidence |
| --- | --- | --- | --- |
| Audio: file preview screen and attachment viewer | Expo Audio builds `OkHttpClient()` privately; the preview plays a leased local file | supports | `node_modules/expo-audio/android/src/main/java/expo/modules/audio/AudioModule.kt:53`; `src/features/files/AudioFilePreview.tsx:17`, `src/features/mesh/useCertificateLocalUri.ts` |
| Audio: inline thread card | Same; each play resolves the asset URL, then leases it | supports | `src/features/threads/ThreadInlineFilePreview.tsx:251`, `useCertificateMediaLease` in `src/features/mesh/useCertificateLocalUri.ts` |
| Audio: voice playback (`usePlaybackAudioPlayer`) | Receives a URI from the two callers above; no other caller passes a remote URL | supports | `src/features/voice-input/usePlaybackAudioPlayer.ts`; callers listed by `grep usePlaybackAudioPlayer` are `AudioFilePreview.tsx` and `ThreadInlineFilePreview.tsx` only |
| HTML render (inline row and fullscreen) | Chromium WebView; the page is downloaded through the certificate transport and the WebView loads the local file | supports (page leased; the WebView never holds the certificate) | `src/features/threads/HtmlRenderWebView.tsx:87`, `src/features/mesh/useCertificateLocalUri.ts` |
| HTML, SVG and linked-document preview in the file viewer and attachment viewer | Same as above | supports (leased) | `src/features/files/WorkspaceFileWebPreview.tsx:36` |
| MCP apps (inline and fullscreen) | Chromium WebView with an inline outer page that frames the environment asset URL | disabled for an origin that has a certificate; shows "App unavailable" | `src/features/threads/McpAppWebView.tsx:165,497`, `src/features/mesh/CertificateSurfaceState.tsx` |
| Device stream | Chromium WebView script in the `:stream` process | supports, from the `:stream` process only (A3); cert presented only to the environment origin | `modules/t3-client-certificates/android/src/main/java/expo/modules/t3clientcertificates/stream/StreamPolicy.kt`, `src/features/mesh/streamWebView.android.tsx`, `src/features/devices/DeviceStreamWebView.tsx` |
| Browser preview stream (route, tablet inspector, floating player) | Chromium WebView script in the `:stream` process | supports, from the `:stream` process only (A3) | `stream/StreamSession.kt`, `src/features/mesh/streamWebView.android.tsx`, `src/features/browser/PreviewStreamWebView.tsx` |
| Inline markdown images (images that share a line with text) | `react-native-enriched-markdown` `ImageSpan` through `ImageDownloader`, which owns a private `OkHttpClient` | supports (leased local file handed to the native view in place of the URL) | `node_modules/react-native-enriched-markdown/android/src/main/java/com/swmansion/enriched/markdown/spans/ImageSpan.kt:71,128`, `.../utils/text/ImageDownloader.kt:28`; `src/native/useMarkdownImageSource.ts:44,61`, `src/features/mesh/nativeMarkdownImageUri.ts` |

### Why the HTML and MCP surfaces differ

The server serves environment HTML with `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-downloads`
(`apps/server/src/http.ts:64,125`). A local `file:` page does not get that header. For the two
leased surfaces the fork loads the file with `allowFileAccess` but without
`allowFileAccessFromFileURLs`, so the page's origin is opaque and it cannot read other files, and
`certificateNavigationAllowed` stops it from navigating to any other `file:` URL (the file viewer
allowed every navigation before; the HTML render viewer already refused them). Scripts in the page
can still run, as they do today.

An MCP app cannot be leased the same way. Its outer page is an inline `html` source that sets
`frame.src` to the asset URL inside `<iframe sandbox="allow-scripts allow-forms">`; Chromium does not
let a non-`file:` page frame a `file:` URL, and inlining the document with `srcdoc` would drop the
server's sandbox header and change the app's base URL. So the surface is refused instead.

## Never reaches the environment

| Feature | Fetcher | Disposition | Evidence |
| --- | --- | --- | --- |
| Block markdown images (thread, file and pull-request markdown) | `renderImage` returns an `expo-image` element for every image, so the native `ImageSpan` path is not used for block images | never reaches (via the native path); the `expo-image` path supports | `src/features/threads/ThreadFeed.tsx:3433` (returns an element on every branch), `src/features/files/FileMarkdownPreview.tsx:104`, `src/features/pull-requests/PullRequestMarkdown.tsx:232`; the library only calls `renderers.image` for block images (`node_modules/react-native-enriched-markdown/docs/ELEMENTS_STRUCTURE.md:165-172`) |
| Markdown link pill icons | `LinkPillIconCache` uses `ImageDownloader`, but the icon is `Image.resolveAssetSource` of a bundled asset | never reaches | `src/native/useEnrichedLinkVariants.ts:170`, `node_modules/react-native-enriched-markdown/android/src/main/java/com/swmansion/enriched/markdown/spans/LinkPillIconCache.kt:45` |
| Composer chip icons | `T3ChipIcons.download` calls `URL(uri).openStream()` for an `http(s)` icon | never reaches: icons are bundled assets, file icons are bundled, and the only remote one is the provider `iconUrl`, which the server sets only to the official ACP registry CDN (`https`, host `cdn.agentclientprotocol.com`) | `modules/t3-composer-editor/android/src/main/java/expo/modules/t3composereditor/T3ChipIcons.kt:36-39`, `src/lib/contextChipIconSource.ts:24`, `packages/provider-acp-registry/src/server/driver.ts:292`, `packages/contracts/src/acpRegistry.ts:25-37` |
| Incoming share URL probe | `expo-sharing` `HttpURLConnection` GET to a URL shared into the app; a failed handshake is caught and reported as `FailedToResolveSharedDataException` | never reaches with a certificate (the connection cannot present one and fails the TLS handshake; the user shared the URL themselves) | `node_modules/expo-sharing/android/src/main/java/expo/modules/sharing/dataParsers/ResolvingShareIntentDataParser.kt:142-143,184-186` |
| Subscription usage widget | `expo-widgets` renders a snapshot the app publishes; no background fetch | never reaches | `src/widgets/publishSubscriptionUsage.android.ts`, `modules/t3-subscription-widget/android` has no network code; the snapshot is built from app state (`src/widgets/SubscriptionUsageCoordinator.tsx:14`) |
| Source view, selectable code, Mermaid | WebView with an inline `html` string, navigation limited to `about:blank` | never reaches | `src/features/files/SourceFileSurface.tsx:376-394` |
| Legal documents | WebView on fixed public `https` pages | never reaches (not an environment URL) | `src/features/settings/components/SettingsLegalDocumentRouteScreen.tsx:97-100` |
| `Linking.openURL` for links, pull requests, provider sign-in | System browser or another app; not an app network stack | never reaches from the app (the system browser has its own certificate handling) | `src/lib/openExternalUrl.ts:49-52` |
| iOS-only WebSocket module | Not built on Android | never reaches | `modules/t3-web-socket` has only `ios/` |

## Residual notes

- The device stream route still runs `useDeviceHubAccess` before it mounts `DeviceStreamWebView` when a
  deep link opens `.../devices` (`src/features/devices/DevicePreviewRouteScreen.tsx:408`). That call is
  an ordinary React Native `fetch`, which presents the certificate; the WebView that would use the
  ticket is not created.
- `File.downloadFileAsync` has no other caller in the app. `FileSystemDownload.kt` uses its own
  `OkHttpClient()` (`node_modules/expo-file-system/android/src/main/java/expo/modules/filesystem/FileSystemDownload.kt:44`),
  so a new caller that takes an environment URL must use `transferWithClientCertificate`.
- Inline markdown images that resolve to an environment origin without a certificate selected keep
  their upstream behaviour; the lease applies only when a certificate is selected for that origin.

## Needs a device

- A real mTLS origin: audio playback (file screen and inline), a leased HTML page, SVG and HTML in the
  file viewer, an inline markdown image from the workspace, and the "App unavailable" state for an MCP app.
- Chromium's decision for the leased `file:` pages: that scripts still run, that `allowFileAccess` on
  the file viewer does not let the page load other files, and that a remote link inside a leased page
  fails rather than prompting for a certificate.
- Deep links `.../devices` and `.../browser`, the tablet inspector and the floating player show the
  unavailable view without creating a WebView.

## Emulator verification (2026-11-18)

Release build of `stack/a1` for x86_64 on the Pixel 8 API 37 emulator, against an isolated
`t3 serve` behind Caddy with `client_auth require_and_verify` on `https://10.0.2.2:8443` (test CA
installed as a user CA, client identity installed into KeyChain from a PKCS#12):

- The KeyChain picker names the requesting server `10.0.2.2:8443`; the alias is stored for
  `https://10.0.2.2:8443/`.
- With a 20-day test certificate, the connection form shows "The selected certificate expires in
  20 days."
- Pairing, `/api/auth/session`, the orchestration snapshot and the RPC WebSocket all pass through
  the mTLS proxy; the environment shows Connected. A cold start reconnects the WebSocket.
- The first attempt failed with "client didn't provide a certificate": expo-app-metrics had
  replaced React Native's client factory (see "Client factory owner" in android-fork.md). Fixed by
  `T3CertificateTransport.reassert()`.
- Changing the environment to a second identity while connected closes the open WebSocket; the
  environment document, ticket, snapshot and the new WebSocket arrive with the second identity's CN,
  without an app restart. The expiry warning goes away for the 200-day certificate.
- Not yet exercised: chat, attachments, media and the leased WebView pages. The isolated server
  had no project.

## Emulator verification, device checks (2026-11-18)

Release build of `stack/a1` (x86_64) on the Pixel 8 API 37 emulator, against an isolated `t3 serve`
behind Caddy with `client_auth require_and_verify` on `https://10.0.2.2:8443` (new test CA as a user
CA, EC P-256 client identities `a1-short` with 20 days and `a1-long` with 200 days in KeyChain).
Evidence is Caddy's `client_common_name` per request and its handshake errors.

| Check | Result |
| --- | --- |
| Pair, project list, reconnect after `am force-stop`, cold start | pass: `oauth/token`, environment, snapshot and `/ws` (101) all carry the identity's CN; the project appears in New thread |
| Chat round trip (Claude Haiku 5.5, "reply with OK") | pass; a second message with a PDF attached also answered |
| Attachment upload (image from the photo picker, PDF from the file picker) | pass: `POST /api/attachments/upload` with the CN; the sent image renders |
| Attachment download and open | pass: image viewer, "Save image" wrote `Pictures/T3 Code/25.png` (634347 bytes, identical size), PDF chip opens the PDF viewer |
| File viewer: image, PDF, video (poster frame and playback 0:00 to 0:04), audio (`.ogg`, AudioTrack started, 0:01/0:05), HTML | pass; every fetch is `okhttp` or `Dalvik` with the CN (workspace-file-exact, media-file-exact, workspace-file assets) |
| Markdown with a block image and an inline image on a text line | pass (preview mode; both load, the inline one through the leased local file) |
| No WebView presents the certificate | pass: no request with a Chromium user agent reached the app layer; a probe page loaded by the leased HTML path (an `img` and a `fetch` to `https://10.0.2.2:8443`) caused exactly two `client didn't provide a certificate` handshake failures at the proxy and no logged request; the page itself loaded from the local file |
| Device stream and browser preview | the entry points are hidden; the `.../devices` deep link opens and closes at once (no device sessions, no WebView, no stream requests). The `.../browser` deep link sat on an endless spinner: fixed (see below). The "Stream unavailable" view was not reached, because it needs a thread with a live device or browser session |
| Remove certificate, then re-select | pass: the connection fails at once (`client didn't provide a certificate` in Caddy) and recovers on selecting a certificate, with the new CN |
| Expiry warning | pass: "The selected certificate expires in 20 days." in the add form and the environment settings; absent for the 200-day certificate |

Not covered: a stream or MCP app "unavailable" view (needs server-side device or MCP app sessions);
audio and HTML previews from inside a thread card (only the file viewer was exercised).

Bug found: `useThreadServerBrowserTabs` returned `loaded: false` forever once streams were disabled,
so the browser route (reachable by deep link) never closed and showed a spinner. Fixed in
the "Support Android client certificates" commit, with a gate test.

Harness notes: another build on the host saturated it twice and the emulator died; it reloads the old
`default_boot` snapshot, which drops the installed CA, KeyChain identities and APK. Save a snapshot
after setting up (`adb emu avd snapshot save default_boot`). A re-imported identity loses the app's key
grant, and the environment then retries forever with "did not answer"; selecting the certificate again
fixes it.

## Emulator verification, A3 stream process (2026-11-18)

Same harness, release build of the A3 stack. The isolated server had device support on, so the
device stream mirrored the emulator itself.

| Check | Result |
| --- | --- |
| No `:stream` process before a stream opens; present after, with `app_webview_stream`; no React Native or Expo in its log | pass |
| Browser preview stream | pass: frames render; `/.well-known/t3/environment` and `/api/preview-stream/ws` (101) arrive with a Chromium user agent and the CN |
| Device stream | pass: `/api/device-hub/...` requests and WebSocket (101) with the CN |
| A main-process WebView after a stream used the origin | pass: still no certificate (handshake failures only) |
| Alias change with a stream open | pass: the `:stream` pid changes, the stream recovers, later requests carry the new CN |
| Touch, keyboard, floating player, Reconnect overlay | pass |
| Killing the `:stream` process; display size and dark-mode changes | pass: one automatic retry, then Reconnect; no crash |

Bugs found and fixed before this run passed: Metro resolved the generic `streamWebView.ts` before
`streamWebView.android.tsx` (the page ran in the app's WebView); Chromium cancelled the stream
WebSocket before any certificate decision (fixed by the priming request); the surface host token was
not ready on first attach. A lost KeyChain grant now shows "The saved certificate is no longer
available. Select it again." on the environment row with a picker, instead of retrying silently.

Not covered: rotation (the app is portrait-only on phones), a real phone and the mesh viewer host.
