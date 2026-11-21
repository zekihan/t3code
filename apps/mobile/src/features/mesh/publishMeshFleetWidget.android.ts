import { requireOptionalNativeModule } from "expo";
import Constants from "expo-constants";

import { isAppActive } from "../../lib/appState";
import type { MeshWidgetSnapshot } from "./meshWidgetSnapshot";

export const meshFleetWidgetEnabled = Constants.expoConfig?.extra?.meshFleetWidget === true;

export async function publishMeshFleetWidget(snapshot: MeshWidgetSnapshot) {
  if (!requireOptionalNativeModule("ExpoWidgets")) return;
  const { default: widget } = await import("./MeshFleetWidget.android");
  if (isAppActive()) widget.updateSnapshot(snapshot);
}
