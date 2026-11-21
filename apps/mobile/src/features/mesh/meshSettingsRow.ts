import { msg } from "gt-react-native";

import type { MessageResolver } from "../../i18n/messages";

export const MESH_ROUTE_TITLE = msg("Mesh", {
  $context: "settings page title for the Mesh screen",
});

/** The Settings > Connections row that opens the Mesh screen. */
export function meshSettingsRow(resolve: MessageResolver) {
  return {
    id: "SettingsMesh",
    icon: "point.3.connected.trianglepath.dotted",
    label: resolve(msg("Mesh", { $context: "settings row that opens the Mesh screen" })),
    target: "SettingsMesh",
  } as const;
}
