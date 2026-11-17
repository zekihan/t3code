import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const read = (relative: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, relative), "utf8");

// Deep links, the tablet inspector and the floating player all mount these two components, and
// their WebView scripts connect to the server without the client certificate. The route-level
// flag only hides the buttons, so the components must refuse on their own. A rebase that moves
// the gate behind a hook, or drops it, fails here.
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

  it("is off on Android", () => {
    expect(read("./streamSurfaces.android.ts")).toContain("streamSurfacesEnabled = false");
  });
});
