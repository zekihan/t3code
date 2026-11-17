import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { compileModsAsync } from "expo/config-plugins";
import { afterEach, describe, expect, it } from "vite-plus/test";

import withAndroidNetworkSecurityConfig from "./withAndroidNetworkSecurityConfig.cjs";
import withMesh from "./withMesh.cjs";
import withMeshNativeMods from "./withMeshNativeMods.cjs";

const VERSION_ENV = {
  T3MESH_VERSION_NAME: "0.1.11-nightly.20261117.4814+mesh.1",
  T3MESH_VERSION_CODE: "481401",
};

const upstreamConfig = () => ({
  name: "T3 Code",
  slug: "t3-code",
  scheme: "t3code",
  version: "2.3.0",
  owner: "pingdotgg",
  updates: {
    enabled: true,
    url: "https://u.expo.dev/project",
    checkAutomatically: "ON_LOAD" as const,
    fallbackToCacheTimeout: 0,
  },
  ios: { bundleIdentifier: "com.t3tools.t3code" },
  android: {
    package: "com.t3tools.t3code",
    googleServicesFile: "./google-services.json",
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "https", host: "app.t3.codes", pathPrefix: "/threads/" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
      {
        action: "VIEW",
        data: [{ scheme: "http", host: "example.com" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
      {
        action: "VIEW",
        data: [{ scheme: "t3mesh", host: "open" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  plugins: [
    "expo-asset",
    ["expo-notifications", { icon: "./icon.png" }],
    ["@clerk/expo", { theme: "./clerk-theme.json" }],
    "@clerk/expo",
    "expo-notifications",
    ["expo-camera", {}],
  ] as unknown[],
  extra: {
    appVariant: "production",
    relay: { url: "https://relay.example" },
    clerk: { publishableKey: "pk_live_x", jwtTemplate: "t3" },
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: "web-client",
    observability: {
      tracesUrl: "https://api.axiom.co/v1/traces",
      tracesDataset: "dataset",
      tracesToken: "token",
    },
    eas: { projectId: "project-id", observe: { endpointUrl: "https://relay.example/observe" } },
  },
});

const projectRoots: string[] = [];

afterEach(() => {
  for (const root of projectRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("withMesh config", () => {
  it("builds a separate app regardless of the upstream variant", () => {
    const config = withMesh(upstreamConfig(), VERSION_ENV) as any;

    expect(config.name).toBe("T3 Mesh");
    expect(config.scheme).toBe("t3mesh");
    expect(config.slug).toBe("t3-mesh");
    expect(config.android.package).toBe("com.noqer.t3mesh");
    expect(config.version).toBe("2.3.0");
    expect(config.ios.bundleIdentifier).toBe("com.t3tools.t3code");
  });

  it("turns upstream accounts off", () => {
    const config = withMesh(upstreamConfig(), VERSION_ENV) as any;

    expect(config.updates).toEqual({ enabled: false, fallbackToCacheTimeout: 0 });
    expect(config).not.toHaveProperty("owner");
    expect(config.android).not.toHaveProperty("googleServicesFile");
    expect(config.android.intentFilters).toEqual([
      {
        action: "VIEW",
        data: [{ scheme: "t3mesh", host: "open" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ]);
    expect(config.extra.eas).toEqual({
      projectId: "00000000-0000-0000-0000-000000000000",
      observe: { endpointUrl: "https://observe.invalid" },
    });
    expect(config.extra.relay).toEqual({ url: null });
    expect(config.extra.clerk).toEqual({ publishableKey: null, jwtTemplate: null });
    expect(config.extra.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID).toBeUndefined();
    expect(config.extra.observability).toEqual({
      tracesUrl: null,
      tracesDataset: null,
      tracesToken: null,
    });
    expect(config.extra.appVariant).toBe("production");
    expect(config.plugins).toEqual([
      [
        withMesh.NATIVE_MODS_PLUGIN,
        { versionName: VERSION_ENV.T3MESH_VERSION_NAME, versionCode: 481401 },
      ],
      "expo-asset",
      ["expo-camera", {}],
    ]);
  });

  it("keeps the input config untouched", () => {
    const input = upstreamConfig();
    withMesh(input, VERSION_ENV);
    expect(input).toEqual(upstreamConfig());
  });
});

describe("withMesh versions", () => {
  it("takes the version from the environment", () => {
    const config = withMesh(upstreamConfig(), VERSION_ENV) as any;
    expect(config.android.versionCode).toBe(481401);
    expect(config.version).toBe("2.3.0");
  });

  it("defaults to a local version when neither variable is set", () => {
    const config = withMesh(upstreamConfig(), {}) as any;
    expect(config.android.versionCode).toBe(1);
    expect(withMesh.resolveVersion({ version: "2.3.0" }, {})).toEqual({
      versionName: "2.3.0+mesh.local",
      versionCode: 1,
    });
  });

  it.each([
    "0.1.11-nightly.20261117.4838+mesh.1",
    "0.1.11-nightly.20261117.4838+mesh.99",
    "0.1.11-nightly.20261117.4825+mesh.3.rollback",
  ])("accepts versionName %s", (versionName) => {
    expect(
      withMesh.resolveVersion(
        { version: "2.3.0" },
        { ...VERSION_ENV, T3MESH_VERSION_NAME: versionName },
      ).versionName,
    ).toBe(versionName);
  });

  it.each([
    "0.1.11+mesh.1",
    "0.1.11-nightly.20261117.4838",
    "0.1.11-nightly.20261117.4838+mesh.100",
    "0.1.11-nightly.20261117.4838+mesh.0.rollbackx",
    "v0.1.11-nightly.20261117.4838+mesh.1",
    "0.1.11-nightly.2026111.4838+mesh.1",
  ])("rejects versionName %s", (versionName) => {
    expect(() =>
      withMesh.resolveVersion(
        { version: "2.3.0" },
        { ...VERSION_ENV, T3MESH_VERSION_NAME: versionName },
      ),
    ).toThrow("T3MESH_VERSION_NAME");
  });

  it.each(["0", "-5", "1.5", "abc", "2100000000", "9999999999", "1e3", "0x10"])(
    "rejects versionCode %s",
    (versionCode) => {
      expect(() =>
        withMesh.resolveVersion(
          { version: "2.3.0" },
          { ...VERSION_ENV, T3MESH_VERSION_CODE: versionCode },
        ),
      ).toThrow("T3MESH_VERSION_CODE");
    },
  );

  it("accepts the largest versionCode", () => {
    expect(
      withMesh.resolveVersion(
        { version: "2.3.0" },
        { ...VERSION_ENV, T3MESH_VERSION_CODE: "2099999999" },
      ).versionCode,
    ).toBe(2099999999);
  });

  it("requires both variables together", () => {
    expect(() =>
      withMesh.resolveVersion({ version: "2.3.0" }, { T3MESH_VERSION_CODE: "5" }),
    ).toThrow("together");
    expect(() =>
      withMesh.resolveVersion(
        { version: "2.3.0" },
        { T3MESH_VERSION_NAME: VERSION_ENV.T3MESH_VERSION_NAME },
      ),
    ).toThrow("together");
  });

  it("replaces the Gradle version fields", () => {
    const gradle = `android {\n    defaultConfig {\n        versionCode 1\n        versionName "2.3.0"\n    }\n}\n`;
    expect(
      withMeshNativeMods.applyGradleVersion(gradle, "0.1.11-nightly.20261117.4814+mesh.1", 481401),
    ).toBe(
      `android {\n    defaultConfig {\n        versionCode 481401\n        versionName "0.1.11-nightly.20261117.4814+mesh.1"\n    }\n}\n`,
    );
    expect(() => withMeshNativeMods.applyGradleVersion("android {}", "x", 1)).toThrow(
      "versionCode",
    );
  });
});

describe("withMesh network security config", () => {
  const BASE_ONLY = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
      <certificates src="user" />
    </trust-anchors>
  </base-config>
</network-security-config>
`;

  it("adds a strict domain-config after the intact base-config, once", () => {
    const xml = withMeshNativeMods.addMeshDomainConfig(BASE_ONLY);

    expect(xml).toContain(`<base-config cleartextTrafficPermitted="true">`);
    expect(xml).toContain(`<certificates src="user" />`);
    expect(xml).toContain(`<domain-config cleartextTrafficPermitted="false">`);
    expect(xml).toContain(`<domain includeSubdomains="true">mesh.noqer.com</domain>`);
    const domain = xml.slice(xml.indexOf("<domain-config"), xml.indexOf("</domain-config>"));
    expect(domain).toContain(`<certificates src="system" />`);
    expect(domain).not.toContain(`src="user"`);
    expect(xml.indexOf("</base-config>")).toBeLessThan(xml.indexOf("<domain-config"));
    expect(withMeshNativeMods.addMeshDomainConfig(xml)).toBe(xml);
  });

  it("fails when upstream's base-config is gone", () => {
    expect(() => withMeshNativeMods.addMeshDomainConfig("<network-security-config/>")).toThrow(
      "base-config",
    );
  });

  it("extends the file upstream's plugin writes and sets the app version", async () => {
    const projectRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesh-"));
    projectRoots.push(projectRoot);
    const main = NodePath.join(projectRoot, "android/app/src/main");
    NodeFS.mkdirSync(main, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(main, "AndroidManifest.xml"),
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:name=".MainApplication"/></manifest>`,
    );
    const gradlePath = NodePath.join(projectRoot, "android/app/build.gradle");
    NodeFS.writeFileSync(
      gradlePath,
      `android {\n    defaultConfig {\n        versionCode 1\n        versionName "2.3.0"\n    }\n}\n`,
    );

    // As in app.config.ts: the mesh plugin is the first entry, upstream plugins follow.
    const mesh = withMesh(upstreamConfig(), VERSION_ENV);
    const config = withAndroidNetworkSecurityConfig(
      withMeshNativeMods(mesh, {
        versionName: VERSION_ENV.T3MESH_VERSION_NAME,
        versionCode: 481401,
      }),
    );
    await compileModsAsync(config, { projectRoot, platforms: ["android"] });

    const xml = NodeFS.readFileSync(
      NodePath.join(main, "res/xml/network_security_config.xml"),
      "utf8",
    );
    expect(xml).toContain(`<certificates src="user" />`);
    expect(xml).toContain("mesh.noqer.com");
    expect(NodeFS.readFileSync(gradlePath, "utf8")).toMatch(
      /versionCode 481401\n\s+versionName "0\.1\.11-nightly\.20261117\.4814\+mesh\.1"/,
    );
  });
});
