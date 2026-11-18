import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const read = (relative: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, relative), "utf8");

// Deep links, the tablet inspector and the floating player all mount these two components. The
// route-level flag only hides the buttons, so the components must refuse on their own when the
// fork turns the streams off. A rebase that moves the gate behind a hook, or drops it, fails here.
describe("stream surface gate", () => {
  it.each([
    ["PreviewStreamWebView", "../browser/PreviewStreamWebView.tsx", "usePreviewStreamAccess"],
    ["DeviceStreamWebView", "../devices/DeviceStreamWebView.tsx", "useState"],
  ])("%s returns before any hook or WebView when streams are disabled", (name, file, hook) => {
    const source = read(file!);
    const start = source.indexOf(`export function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body).toMatch(/if \(!streamSurfacesEnabled\) return <StreamSurfaceUnavailable/);
    expect(body).not.toContain(hook!);
    expect(body).not.toContain("<WebView");
    expect(source).toContain('import { streamSurfacesEnabled } from "../mesh/streamSurfaces";');
  });

  it("reports the browser tab list as loaded when streams are disabled", () => {
    // The browser route closes itself once the list is loaded and empty; without this a deep link
    // to it would spin forever, because the disabled hook never lists tabs.
    expect(read("../../state/preview.ts")).toMatch(
      /loaded: tabs\.listed \|\| \(input\.enabled && !streamSurfacesEnabled\)/,
    );
  });

  it("keeps a kill switch for the Android streams and needs SurfaceControlViewHost", () => {
    const source = read("./streamSurfaces.android.ts");
    expect(source).toContain("const STREAMS_DISABLED = false;");
    expect(source).toContain("!STREAMS_DISABLED");
    expect(source).toContain("MIN_STREAM_API_LEVEL = 30");
  });

  // The WebView that holds the page is the one in the `:stream` process. Importing the real one
  // in these components would put the script back in the app's own WebView data directory.
  it.each([
    ["PreviewStreamWebView", "../browser/PreviewStreamWebView.tsx"],
    ["DeviceStreamWebView", "../devices/DeviceStreamWebView.tsx"],
  ])("%s takes its WebView from the stream seam", (_name, file) => {
    const source = read(file);
    expect(source).toContain('from "../mesh/streamWebView";');
    expect(source).not.toContain('from "react-native-webview"');
  });

  // Metro tries every platform and generic form of one extension before the next, so a generic
  // `.ts` beats `.android.tsx`: the app then bundles the real WebView and the page runs in the
  // app process, where it cannot present the certificate.
  it("keeps the stream seam's generic file in the same extension as its Android file", () => {
    expect(NodeFS.existsSync(NodePath.join(import.meta.dirname, "streamWebView.android.tsx"))).toBe(
      true,
    );
    expect(NodeFS.existsSync(NodePath.join(import.meta.dirname, "streamWebView.tsx"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(import.meta.dirname, "streamWebView.ts"))).toBe(false);
  });
});
