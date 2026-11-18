import { Platform } from "react-native";

/**
 * The device stream and the browser preview stream run in the `:stream` process (see
 * streamWebView.android.tsx), which draws into the app through SurfaceControlViewHost.
 * Flip this to take both streams away again, e.g. if a Chromium update breaks the bridge.
 */
const STREAMS_DISABLED = false;

/** SurfaceControlViewHost arrived with Android 11. */
const MIN_STREAM_API_LEVEL = 30;

export const streamSurfacesEnabled =
  !STREAMS_DISABLED && Number(Platform.Version) >= MIN_STREAM_API_LEVEL;
