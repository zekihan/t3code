import { useAtomSet } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";

import { openSettings } from "../settings/settings-navigation";
import type { MeshMachine } from "./meshMachines";
import { meshPairingOriginAtom } from "./meshPairingPrefill";

export function useMeshPairing(entry: "home" | "settings") {
  const navigation = useNavigation();
  const setMeshPairingOrigin = useAtomSet(meshPairingOriginAtom);

  return (machine: MeshMachine) => {
    const params = { meshPairingOrigin: machine.viewerOrigin };
    setMeshPairingOrigin(machine.viewerOrigin);
    if (entry === "home") {
      openSettings(navigation, "SettingsEnvironmentNew", params);
    } else {
      navigation.navigate("SettingsEnvironmentNew", params);
    }
  };
}
