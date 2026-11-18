import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { compileModsAsync } from "expo/config-plugins";
import { afterEach, describe, expect, it } from "vite-plus/test";

import withMeshLocalNetwork from "./withMeshLocalNetwork.cjs";

const PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK";
const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET"/>
  <application android:name=".MainApplication"/>
</manifest>`;
const catalog = (targetSdk: number) =>
  `[versions]\nminSdk = "24"\ntargetSdk = "${targetSdk}"\ncompileSdk = "37"\n`;

const projectRoots: string[] = [];

afterEach(() => {
  for (const root of projectRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

interface Project {
  readonly props?: { targetSdk?: number | null };
  readonly manifest?: string;
  /** What expo-build-properties or the template left in gradle.properties; null for no file. */
  readonly gradleProperties?: string | null;
  /** React Native's version catalog; null for none. */
  readonly versionCatalog?: string | null;
}

async function prebuild(project: Project = {}) {
  const projectRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesh-lnp-"));
  projectRoots.push(projectRoot);
  const android = NodePath.join(projectRoot, "android");
  const manifestPath = NodePath.join(android, "app/src/main/AndroidManifest.xml");
  NodeFS.mkdirSync(NodePath.dirname(manifestPath), { recursive: true });
  NodeFS.writeFileSync(manifestPath, project.manifest ?? MANIFEST);
  const gradleProperties =
    project.gradleProperties === undefined
      ? "org.gradle.jvmargs=-Xmx2048m\n"
      : project.gradleProperties;
  if (gradleProperties !== null) {
    NodeFS.writeFileSync(NodePath.join(android, "gradle.properties"), gradleProperties);
  }
  const reactNative = NodePath.join(projectRoot, "node_modules/react-native");
  NodeFS.mkdirSync(NodePath.join(reactNative, "gradle"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(reactNative, "package.json"), `{"name":"react-native"}`);
  const versionCatalog =
    project.versionCatalog === undefined ? catalog(36) : project.versionCatalog;
  if (versionCatalog !== null) {
    NodeFS.writeFileSync(NodePath.join(reactNative, "gradle/libs.versions.toml"), versionCatalog);
  }
  await compileModsAsync(withMeshLocalNetwork({ name: "x", slug: "x" }, project.props), {
    projectRoot,
    platforms: ["android"],
  });
  return {
    permissions: [
      ...NodeFS.readFileSync(manifestPath, "utf8").matchAll(
        /<uses-permission android:name="([^"]+)"/g,
      ),
    ].map((match) => match[1]),
    properties: NodeFS.readFileSync(NodePath.join(android, "gradle.properties"), "utf8"),
  };
}

describe("withMeshLocalNetwork manifest", () => {
  it("does not declare the permission for upstream's target 36, which would withdraw the implicit grant", async () => {
    const { permissions } = await prebuild();
    expect(permissions).toEqual(["android.permission.INTERNET"]);
  });

  it("removes the permission below 37 even when something else declared it", async () => {
    const manifest = MANIFEST.replace(
      "<application",
      `<uses-permission android:name="${PERMISSION}"/>\n  <application`,
    );
    const { permissions } = await prebuild({ manifest });
    expect(permissions).not.toContain(PERMISSION);
    expect(permissions).toContain("android.permission.INTERNET");
  });

  it("declares it when React Native's default target reaches 37", async () => {
    const { permissions } = await prebuild({ versionCatalog: catalog(37) });
    expect(permissions).toContain(PERMISSION);
    expect(permissions).toContain("android.permission.INTERNET");
  });

  it("declares it when expo-build-properties sets 37, which wins over the catalog", async () => {
    const { permissions } = await prebuild({
      gradleProperties: "android.targetSdkVersion=37\n",
      versionCatalog: catalog(36),
    });
    expect(permissions).toContain(PERMISSION);
    const lower = await prebuild({
      gradleProperties: "android.targetSdkVersion=36\n",
      versionCatalog: catalog(37),
    });
    expect(lower.permissions).not.toContain(PERMISSION);
  });

  it("declares it once", async () => {
    const manifest = MANIFEST.replace(
      "<application",
      `<uses-permission android:name="${PERMISSION}"/>\n  <application`,
    );
    const { permissions } = await prebuild({ manifest, versionCatalog: catalog(37) });
    expect(permissions.filter((name) => name === PERMISSION)).toHaveLength(1);
  });

  it("fails closed when the target cannot be read", async () => {
    await expect(prebuild({ gradleProperties: null, versionCatalog: null })).rejects.toThrow(
      "cannot be decided",
    );
  });
});

describe("withMeshLocalNetwork target override", () => {
  it("replaces the target and compile SDK, keeping every other property", async () => {
    const { properties } = await prebuild({
      props: { targetSdk: 37 },
      gradleProperties:
        "org.gradle.jvmargs=-Xmx2048m\nandroid.targetSdkVersion=36\nandroid.compileSdkVersion=36\n",
    });
    expect(properties).toContain("org.gradle.jvmargs=-Xmx2048m");
    expect(properties).toContain("android.targetSdkVersion=37");
    expect(properties).toContain("android.compileSdkVersion=37");
    expect(properties).toContain("android.suppressUnsupportedCompileSdk=37");
    expect(properties).not.toContain("android.targetSdkVersion=36");
    expect(properties.match(/android\.targetSdkVersion=/g)).toHaveLength(1);
  });

  it("makes the build declare the permission", async () => {
    const { permissions } = await prebuild({ props: { targetSdk: 37 } });
    expect(permissions).toContain(PERMISSION);
  });

  it("leaves the properties alone without an override", async () => {
    const { properties } = await prebuild({ props: { targetSdk: null } });
    expect(properties).not.toContain("android.targetSdkVersion");
    expect(properties).not.toContain("suppressUnsupportedCompileSdk");
  });

  it("sets and replaces gradle properties without duplicates", () => {
    const next = withMeshLocalNetwork.setGradleProperties(
      [
        { type: "comment", value: "x" },
        { type: "property", key: "a", value: "1" },
        { type: "property", key: "b", value: "2" },
      ],
      { a: 9, c: "3" },
    );
    expect(next).toEqual([
      { type: "comment", value: "x" },
      { type: "property", key: "b", value: "2" },
      { type: "property", key: "a", value: "9" },
      { type: "property", key: "c", value: "3" },
    ]);
  });
});

describe("resolveBuildTargetSdk", () => {
  const resolve = withMeshLocalNetwork.resolveBuildTargetSdk;

  it("prefers gradle.properties over the version catalog", () => {
    expect(
      resolve({
        gradleProperties: "a=1\nandroid.targetSdkVersion=37\n",
        versionCatalog: catalog(36),
      }),
    ).toBe(37);
  });

  it("falls back to the catalog and reports nothing when neither says", () => {
    expect(resolve({ gradleProperties: "a=1\n", versionCatalog: catalog(36) })).toBe(36);
    expect(resolve({ gradleProperties: null, versionCatalog: catalog(37) })).toBe(37);
    expect(resolve({ gradleProperties: "a=1\n", versionCatalog: "[versions]\n" })).toBeNull();
    expect(resolve({ gradleProperties: null, versionCatalog: null })).toBeNull();
  });
});

describe("T3MESH_TARGET_SDK", () => {
  it("is off unless set", () => {
    expect(withMeshLocalNetwork.resolveTargetSdk({})).toBeNull();
    expect(withMeshLocalNetwork.resolveTargetSdk({ T3MESH_TARGET_SDK: "  " })).toBeNull();
  });

  it("reads an API level", () => {
    expect(withMeshLocalNetwork.resolveTargetSdk({ T3MESH_TARGET_SDK: "37" })).toBe(37);
    expect(withMeshLocalNetwork.resolveTargetSdk({ T3MESH_TARGET_SDK: " 36 " })).toBe(36);
  });

  it.each(["35", "abc", "3.7", "370", "-37", "0x25"])("rejects %s", (value) => {
    expect(() => withMeshLocalNetwork.resolveTargetSdk({ T3MESH_TARGET_SDK: value })).toThrow(
      "T3MESH_TARGET_SDK",
    );
  });

  it("refuses to run in CI, where a release must keep upstream's target", () => {
    expect(() =>
      withMeshLocalNetwork.resolveTargetSdk({ T3MESH_TARGET_SDK: "37", CI: "true" }),
    ).toThrow("CI");
    expect(withMeshLocalNetwork.resolveTargetSdk({ CI: "true" })).toBeNull();
  });
});
