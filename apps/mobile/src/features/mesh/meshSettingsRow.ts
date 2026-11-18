/** The Settings > Connections row that opens the Mesh screen. */
export function meshSettingsRow() {
  return {
    id: "SettingsMesh",
    icon: "point.3.connected.trianglepath.dotted",
    label: "Mesh",
    target: "SettingsMesh",
  } as const;
}
