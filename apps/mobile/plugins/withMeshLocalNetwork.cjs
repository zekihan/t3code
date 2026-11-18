const fs = require("node:fs");
const path = require("node:path");
const { AndroidConfig, withFinalizedMod, withGradleProperties } = require("expo/config-plugins");

// Android 17 gates local network traffic behind this permission for apps targeting 37 or newer.
// Below that the platform grants access implicitly, and declaring the permission withdraws that
// grant (a target 36 build that declared it timed out on 10.0.2.2). So the manifest has it
// exactly when the resolved target is 37 or newer, from an upstream bump or the override.
const LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK";
const LOCAL_NETWORK_SDK = 37;

const SUPPRESS_UNSUPPORTED_COMPILE_SDK = "android.suppressUnsupportedCompileSdk";

const TARGET_SDK_PATTERN = /^\d{2}$/;
// The lowest target worth overriding to: upstream's value is 36, and the point is to reach 37.
const MIN_TARGET_SDK = 36;

// Test-only. Never set in CI: a release must carry upstream's target (see the release job's hold).
/** @param {Record<string, string | undefined>} env */
function resolveTargetSdk(env) {
  const raw = env.T3MESH_TARGET_SDK?.trim();
  if (!raw) return null;
  if (env.CI) {
    throw new Error("T3MESH_TARGET_SDK is for local test builds and must not be set in CI.");
  }
  const targetSdk = TARGET_SDK_PATTERN.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(targetSdk) || targetSdk < MIN_TARGET_SDK) {
    throw new Error(
      `T3MESH_TARGET_SDK must be an API level of ${MIN_TARGET_SDK} or more, got ${JSON.stringify(raw)}.`,
    );
  }
  return targetSdk;
}

/** @param {{ key?: string, type: string, value?: string }[]} properties */
function setGradleProperties(properties, values) {
  const next = properties.filter((item) => item.type !== "property" || !(item.key in values));
  for (const [key, value] of Object.entries(values)) {
    next.push({ type: "property", key, value: String(value) });
  }
  return next;
}

/**
 * The `targetSdkVersion` the generated project builds with: `android.targetSdkVersion` in
 * gradle.properties (expo-build-properties, or the override) when set, otherwise React Native's
 * default in its version catalog. Null when neither says.
 *
 * @param {{ gradleProperties: string | null, versionCatalog: string | null }} sources
 */
function resolveBuildTargetSdk({ gradleProperties, versionCatalog }) {
  const fromProperties = /^android\.targetSdkVersion=(\d+)\s*$/m.exec(gradleProperties ?? "");
  if (fromProperties) return Number(fromProperties[1]);
  const fromCatalog = /^targetSdk\s*=\s*"(\d+)"\s*$/m.exec(versionCatalog ?? "");
  return fromCatalog ? Number(fromCatalog[1]) : null;
}

/** Adds the permission for a target of 37 or newer and removes it below that. */
function applyLocalNetworkPermission(manifest, targetSdk) {
  if (targetSdk >= LOCAL_NETWORK_SDK) {
    AndroidConfig.Permissions.ensurePermission(manifest, LOCAL_NETWORK_PERMISSION);
  } else {
    AndroidConfig.Permissions.removePermissions(manifest, [LOCAL_NETWORK_PERMISSION]);
  }
  return manifest;
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readVersionCatalog(projectRoot) {
  try {
    const reactNative = require.resolve("react-native/package.json", { paths: [projectRoot] });
    return readIfPresent(path.join(path.dirname(reactNative), "gradle", "libs.versions.toml"));
  } catch {
    return null;
  }
}

// The mesh plugins are the first entries of the plugin list, so their mods run after every
// upstream plugin's: the override wins over expo-build-properties. The permission is decided in a
// finalized mod, which sees the target that every other mod settled on.
/**
 * @param {any} config
 * @param {{ targetSdk?: number | null }} [options]
 */
function withMeshLocalNetwork(config, options = {}) {
  const { targetSdk = null } = options;
  const withOverride =
    targetSdk === null
      ? config
      : withGradleProperties(config, (modConfig) => {
          modConfig.modResults = setGradleProperties(modConfig.modResults, {
            "android.targetSdkVersion": targetSdk,
            "android.compileSdkVersion": targetSdk,
            [SUPPRESS_UNSUPPORTED_COMPILE_SDK]: targetSdk,
          });
          return modConfig;
        });
  return withFinalizedMod(withOverride, [
    "android",
    async (modConfig) => {
      const { platformProjectRoot, projectRoot } = modConfig.modRequest;
      const resolved = resolveBuildTargetSdk({
        gradleProperties: readIfPresent(path.join(platformProjectRoot, "gradle.properties")),
        versionCatalog: readVersionCatalog(projectRoot),
      });
      // Either choice breaks local network access on Android 17 if it is wrong: fail closed.
      if (resolved === null) {
        throw new Error(
          "Cannot tell which targetSdkVersion the build uses, so the local network permission cannot be decided.",
        );
      }
      const file = path.join(platformProjectRoot, "app", "src", "main", "AndroidManifest.xml");
      const manifest = await AndroidConfig.Manifest.readAndroidManifestAsync(file);
      applyLocalNetworkPermission(manifest, resolved);
      await AndroidConfig.Manifest.writeAndroidManifestAsync(file, manifest);
      return modConfig;
    },
  ]);
}

withMeshLocalNetwork.LOCAL_NETWORK_PERMISSION = LOCAL_NETWORK_PERMISSION;
withMeshLocalNetwork.resolveTargetSdk = resolveTargetSdk;
withMeshLocalNetwork.resolveBuildTargetSdk = resolveBuildTargetSdk;
withMeshLocalNetwork.applyLocalNetworkPermission = applyLocalNetworkPermission;
withMeshLocalNetwork.setGradleProperties = setGradleProperties;

module.exports = withMeshLocalNetwork;
