import type { Rationale } from "react-native";

export const fleetNotificationsAvailable = false;
export const isFleetNotificationsEnabled = () => false;
export const setFleetNotificationsEnabled = async (_enabled: boolean, _rationale: Rationale) =>
  false;
