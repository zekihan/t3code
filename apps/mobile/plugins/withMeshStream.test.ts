import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const { guardStreamProcessStartup, guardStreamProcessConfiguration } =
  require("./withMeshStream.cjs") as {
    guardStreamProcessStartup(source: string): string;
    guardStreamProcessConfiguration(source: string): string;
  };
const { installCertificateTransport, reassertCertificateTransport } =
  require("./withAndroidClientCertificates.cjs") as {
    installCertificateTransport(source: string): string;
    reassertCertificateTransport(source: string): string;
  };
const { START_GUARD, CONFIGURATION_GUARD } = require("./lib/meshStreamGuard.cjs") as {
  START_GUARD: string;
  CONFIGURATION_GUARD: string;
};
const install = "expo.modules.t3clientcertificates.T3CertificateTransport.install(this)";

const template = `class MainApplication : Application(), ReactApplication {
  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}`;

describe("stream process start-up prebuild", () => {
  it("stops start-up in the stream process before React Native and Expo", () => {
    expect(guardStreamProcessStartup(template)).toBe(
      template.replace("super.onCreate()", `super.onCreate()\n    ${START_GUARD}`),
    );
  });

  it("is idempotent across repeated prebuilds", () => {
    const generated = guardStreamProcessStartup(template);
    expect(guardStreamProcessStartup(generated)).toBe(generated);
  });

  it("preserves Windows line endings", () => {
    const generated = guardStreamProcessStartup(template.replaceAll("\n", "\r\n"));
    expect(generated).toContain(`super.onCreate()\r\n    ${START_GUARD}\r\n`);
    expect(guardStreamProcessStartup(generated)).toBe(generated);
  });

  it.each([
    "class MainApplication {}",
    template.replace("super.onCreate()", "initializeNetworking()\n    super.onCreate()"),
    template + template,
  ])("rejects a template whose start-up it cannot guard", (source) => {
    expect(() => guardStreamProcessStartup(source)).toThrow(
      "Cannot keep the stream process out of React Native startup",
    );
  });

  it.each([
    template.replace("loadReactNative(this)", `loadReactNative(this)\n    ${START_GUARD}`),
    template.replace(
      "super.onCreate()",
      `super.onCreate()\n    ${START_GUARD}\n    ${START_GUARD}`,
    ),
  ])("rejects a misplaced or duplicated guard", (source) => {
    expect(() => guardStreamProcessStartup(source)).toThrow(
      "The stream process guard must follow super.onCreate() directly",
    );
  });

  it("keeps Expo configuration callbacks out of the stream process", () => {
    const generated = guardStreamProcessConfiguration(template);
    expect(generated).toBe(
      template.replace(
        "super.onConfigurationChanged(newConfig)",
        `super.onConfigurationChanged(newConfig)\n    ${CONFIGURATION_GUARD}`,
      ),
    );
    expect(guardStreamProcessConfiguration(generated)).toBe(generated);
  });

  it("leaves a template without Expo configuration callbacks alone", () => {
    const source = template.replace(
      "ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)",
      "",
    );
    expect(guardStreamProcessConfiguration(source)).toBe(source);
  });

  it.each([
    template.replace("super.onConfigurationChanged(newConfig)", "refresh()"),
    template.replace("newConfig: Configuration", "config: Configuration"),
  ])("rejects an Expo configuration callback it cannot guard", (source) => {
    expect(() => guardStreamProcessConfiguration(source)).toThrow(
      "Cannot keep the stream process out of Expo configuration callbacks",
    );
  });

  it.each([
    [
      "certificate plugin first",
      (source: string) => guardStreamProcessStartup(installCertificateTransport(source)),
    ],
    [
      "stream plugin first",
      (source: string) => installCertificateTransport(guardStreamProcessStartup(source)),
    ],
  ])("composes with the certificate transport, %s", (_order, apply) => {
    const generated = apply(template);
    expect(generated).toContain(`super.onCreate()\n    ${START_GUARD}\n    ${install}\n`);
    // Applying both again, in either order, must not move or duplicate anything.
    expect(guardStreamProcessStartup(installCertificateTransport(generated))).toBe(generated);
    expect(installCertificateTransport(guardStreamProcessStartup(generated))).toBe(generated);
    const reasserted = reassertCertificateTransport(generated);
    expect(guardStreamProcessStartup(reasserted)).toBe(reasserted);
  });

  it("puts the guard before the install in the order the app runs them", () => {
    const generated = guardStreamProcessStartup(installCertificateTransport(template));
    const body = generated.slice(generated.indexOf("override fun onCreate()"));
    expect(body.indexOf(START_GUARD)).toBeGreaterThan(body.indexOf("super.onCreate()"));
    expect(body.indexOf(START_GUARD)).toBeLessThan(body.indexOf(install));
    expect(body.indexOf(install)).toBeLessThan(body.indexOf("loadReactNative(this)"));
  });
});
