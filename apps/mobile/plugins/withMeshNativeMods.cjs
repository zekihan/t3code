const fs = require("node:fs");
const path = require("node:path");
const {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
} = require("expo/config-plugins");

const MESH_DOMAIN = "mesh.noqer.com";

const MESH_DOMAIN_CONFIG = `  <domain-config cleartextTrafficPermitted="false">
    <domain includeSubdomains="true">${MESH_DOMAIN}</domain>
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </domain-config>
`;

function addMeshDomainConfig(xml) {
  if (xml.includes(`>${MESH_DOMAIN}<`)) return xml;
  const baseEnd = "</base-config>\n";
  if (!xml.includes(baseEnd)) {
    throw new Error(
      "network_security_config.xml has no base-config to place the mesh domain after.",
    );
  }
  return xml.replace(baseEnd, `${baseEnd}${MESH_DOMAIN_CONFIG}`);
}

function applyGradleVersion(contents, versionName, versionCode) {
  const codePattern = /versionCode\s+\d+/;
  const namePattern = /versionName\s+"[^"]*"/;
  if (!codePattern.test(contents) || !namePattern.test(contents)) {
    throw new Error("app/build.gradle has no versionCode and versionName to replace.");
  }
  return contents
    .replace(codePattern, `versionCode ${versionCode}`)
    .replace(namePattern, `versionName "${versionName}"`);
}

// Expo derives versionName from `version`, which must stay upstream's, so Gradle gets it directly.
/** @param {{ versionName: string, versionCode: number }} props */
function withMeshNativeMods(config, { versionName, versionCode }) {
  config = withAndroidManifest(config, (modConfig) => {
    const { addMetaDataItemToMainApplication, getMainApplicationOrThrow } = AndroidConfig.Manifest;
    addMetaDataItemToMainApplication(
      getMainApplicationOrThrow(modConfig.modResults),
      "expo.modules.widgets.LAUNCH_URL.SubscriptionUsage",
      `${modConfig.scheme}://settings/mesh`,
    );
    return modConfig;
  });
  const withGradle = withAppBuildGradle(config, (modConfig) => {
    modConfig.modResults.contents = applyGradleVersion(
      modConfig.modResults.contents,
      versionName,
      versionCode,
    );
    return modConfig;
  });
  return withDangerousMod(withGradle, [
    "android",
    async (modConfig) => {
      const file = path.join(
        modConfig.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "xml",
        "network_security_config.xml",
      );
      fs.writeFileSync(file, addMeshDomainConfig(fs.readFileSync(file, "utf8")));
      return modConfig;
    },
  ]);
}

withMeshNativeMods.addMeshDomainConfig = addMeshDomainConfig;
withMeshNativeMods.applyGradleVersion = applyGradleVersion;

module.exports = withMeshNativeMods;
