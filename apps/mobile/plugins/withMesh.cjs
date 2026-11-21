const { resolveTargetSdk } = require("./withMeshLocalNetwork.cjs");

const MESH_ANDROID_PACKAGE = "com.noqer.t3mesh";
const MESH_SCHEME = "t3mesh";
const MESH_APP_NAME = "T3 Mesh";
// expo-dev-client registers `exp+<slug>` as a second URL scheme.
const MESH_SLUG = "t3-mesh";
const MESH_NATIVE_MODS_PLUGIN = "./plugins/withMeshNativeMods.cjs";
// Keeps React Native out of the `:stream` process that hosts the device and browser preview streams.
const MESH_STREAM_PLUGIN = "./plugins/withMeshStream.cjs";
// Declares Android 17's local network permission; T3MESH_TARGET_SDK (test builds only) sets the target.
const MESH_LOCAL_NETWORK_PLUGIN = "./plugins/withMeshLocalNetwork.cjs";

const VERSION_NAME_PATTERN = /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+\+mesh\.\d{1,2}(\.rollback)?$/;
const MAX_VERSION_CODE = 2100000000;
// Config plugins whose native config only serves upstream's push and sign-in services.
// expo-observe's native module refuses to start without a project ID, which kills app start-up.
// A nil UUID keeps it alive; its endpoint is observe.invalid and dispatching stays off.
const PLACEHOLDER_EAS_PROJECT_ID = "00000000-0000-0000-0000-000000000000";
const REMOVED_PLUGINS = new Set(["expo-notifications", "@clerk/expo"]);

/** @param {Record<string, string | undefined>} env */
function resolveVersion(config, env) {
  const rawName = env.T3MESH_VERSION_NAME?.trim();
  const rawCode = env.T3MESH_VERSION_CODE?.trim();
  if (!rawName && !rawCode) {
    return { versionName: `${config.version}+mesh.local`, versionCode: 1 };
  }
  if (!rawName || !rawCode) {
    throw new Error("T3MESH_VERSION_NAME and T3MESH_VERSION_CODE must be set together.");
  }
  if (!VERSION_NAME_PATTERN.test(rawName)) {
    throw new Error(
      `T3MESH_VERSION_NAME must look like 0.1.11-nightly.20261117.4838+mesh.1, got ${JSON.stringify(rawName)}.`,
    );
  }
  const versionCode = /^[0-9]+$/.test(rawCode) ? Number(rawCode) : Number.NaN;
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode >= MAX_VERSION_CODE) {
    throw new Error(
      `T3MESH_VERSION_CODE must be a positive integer below ${MAX_VERSION_CODE}, got ${JSON.stringify(rawCode)}.`,
    );
  }
  return { versionName: rawName, versionCode };
}

// Verified and web links belong to the official app's domains; other filters stay so a new
// upstream one reaches the release job's manifest check instead of vanishing silently.
function keepsIntentFilter(filter) {
  if (filter.autoVerify) return false;
  return !(filter.data ?? []).some((data) => data.scheme === "https" || data.scheme === "http");
}

function pluginName(plugin) {
  return Array.isArray(plugin) ? plugin[0] : plugin;
}

function configureMeshWidget(plugin) {
  if (!Array.isArray(plugin) || plugin[0] !== "expo-widgets") return plugin;
  const [name, options] = plugin;
  return [
    name,
    {
      ...options,
      widgets: options.widgets.map((widget) =>
        widget.name === "SubscriptionUsage"
          ? {
              ...widget,
              displayName: "Mesh fleet status",
              description: "Fleet health, connection path, and device certificate status.",
              android: {
                ...widget.android,
                initialLayout: "./src/features/mesh/MeshFleetWidget.android.tsx",
              },
            }
          : widget,
      ),
    },
  ];
}

// Static edits happen here, not in a plugin, so `expo config --type public` and anything else that
// reads the config without running plugins sees the fork. The native edits live in a plugin entry.
/** @param {Record<string, string | undefined>} [env] */
function withMesh(config, env = process.env) {
  const { versionName, versionCode } = resolveVersion(config, env);
  const targetSdk = resolveTargetSdk(env);
  const {
    owner: _owner,
    updates: upstreamUpdates,
    extra: upstreamExtra,
    android: upstreamAndroid,
    ...rest
  } = config;
  const { url: _url, checkAutomatically: _check, ...updates } = upstreamUpdates ?? {};
  const { googleServicesFile: _googleServicesFile, ...android } = upstreamAndroid ?? {};
  const { eas, ...extra } = upstreamExtra ?? {};
  const { projectId: _projectId, ...easRest } = eas ?? {};

  return {
    ...rest,
    name: MESH_APP_NAME,
    slug: MESH_SLUG,
    scheme: MESH_SCHEME,
    updates: { ...updates, enabled: false },
    android: {
      ...android,
      package: MESH_ANDROID_PACKAGE,
      versionCode,
      permissions: [
        ...new Set([...(android.permissions ?? []), "android.permission.POST_NOTIFICATIONS"]),
      ],
      intentFilters: (android.intentFilters ?? []).filter(keepsIntentFilter),
    },
    // First entries: their mods are registered first, so they run after every upstream plugin's.
    plugins: [
      [MESH_NATIVE_MODS_PLUGIN, { versionName, versionCode }],
      MESH_STREAM_PLUGIN,
      [MESH_LOCAL_NETWORK_PLUGIN, { targetSdk }],
      ...(config.plugins ?? [])
        .filter((plugin) => !REMOVED_PLUGINS.has(pluginName(plugin)))
        .map(configureMeshWidget),
    ],
    extra: {
      ...extra,
      meshFleetWidget: true,
      relay: { url: null },
      clerk: { publishableKey: null, jwtTemplate: null },
      EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: undefined,
      EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: undefined,
      EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: undefined,
      EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: undefined,
      observability: { tracesUrl: null, tracesDataset: null, tracesToken: null },
      eas: {
        ...easRest,
        projectId: PLACEHOLDER_EAS_PROJECT_ID,
        observe: { endpointUrl: "https://observe.invalid" },
      },
    },
  };
}

withMesh.resolveVersion = resolveVersion;
withMesh.resolveTargetSdk = resolveTargetSdk;
withMesh.NATIVE_MODS_PLUGIN = MESH_NATIVE_MODS_PLUGIN;
withMesh.STREAM_PLUGIN = MESH_STREAM_PLUGIN;
withMesh.LOCAL_NETWORK_PLUGIN = MESH_LOCAL_NETWORK_PLUGIN;

module.exports = withMesh;
