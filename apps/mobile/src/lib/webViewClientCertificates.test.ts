import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const androidSource = NodePath.join(
  NodePath.dirname(require.resolve("react-native-webview/package.json")),
  "android/src/main/java",
);

function javaFiles(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return javaFiles(full);
    return /\.(java|kt)$/.test(entry.name) ? [full] : [];
  });
}

// Android caches a WebView's certificate decision per host and port for the whole data directory.
// android.webkit.WebViewClient cancels certificate requests by default, so no main-process WebView
// may answer one. Overriding the callback anywhere in react-native-webview would break that.
describe("react-native-webview client certificates", () => {
  it("leaves client certificate requests to the cancelling platform default", () => {
    const files = javaFiles(androidSource);
    expect(files.length).toBeGreaterThan(0);
    const overriding = files.filter((file) =>
      /onReceivedClientCertRequest|ClientCertRequest/.test(NodeFS.readFileSync(file, "utf8")),
    );
    expect(overriding).toEqual([]);
  });
});
