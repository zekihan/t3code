import { requireOptionalNativeModule } from "expo";
import { PermissionsAndroid, Platform, type Rationale } from "react-native";

interface FleetNotificationsNative {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): Promise<boolean>;
}

const native = requireOptionalNativeModule<FleetNotificationsNative>("T3MeshFleetNotifications");

export const fleetNotificationsAvailable = native !== null;
export const isFleetNotificationsEnabled = () => native?.isEnabled() ?? false;

export async function setFleetNotificationsEnabled(enabled: boolean, rationale: Rationale) {
  if (!native) return false;
  if (enabled && Number(Platform.Version) >= 33) {
    const grant = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      rationale,
    );
    if (grant !== PermissionsAndroid.RESULTS.GRANTED) return false;
  }
  return native.setEnabled(enabled);
}
