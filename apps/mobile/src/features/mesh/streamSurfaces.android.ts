/**
 * The device stream and browser preview stream run a script in a main-process WebView that
 * connects to the T3 server. A WebView cannot be given a per-surface client certificate, so the
 * fork does not offer them on Android until they move to a separate process.
 */
export const streamSurfacesEnabled = false;
