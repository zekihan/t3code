import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { clientCertificateWarning } from "../../lib/clientCertificateExpiry";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { pairedEnvironmentsByMachine } from "./meshEnvironments";
import type { MeshMachine } from "./meshMachines";
import { MeshMachinesView } from "./MeshMachinesView";
import { useMeshMachines } from "./useMeshMachines";

/** Settings > Mesh: the machines the hub lists for this phone's identity. */
export function MeshRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { connectedEnvironments, onChangeConnectionPairingUrl } = useRemoteConnections();
  const mesh = useMeshMachines();
  const [pulled, setPulled] = useState(false);
  const paired = pairedEnvironmentsByMachine(mesh.state.machines ?? [], connectedEnvironments);

  const pull = () => {
    setPulled(true);
    void mesh.refresh().finally(() => setPulled(false));
  };
  // Pairing stays manual: the form opens with the viewer's address and waits for the code.
  const pair = (machine: MeshMachine) => {
    onChangeConnectionPairingUrl(machine.viewerOrigin);
    navigation.navigate("SettingsEnvironmentNew");
  };
  const open = (environmentId: EnvironmentId) =>
    navigation.navigate("SettingsEnvironmentDetail", { environmentId });

  return (
    <SettingsScreen
      title="Mesh"
      actions={[
        {
          accessibilityLabel: "Refresh machines",
          icon: "arrow.clockwise",
          disabled: mesh.state.loading,
          onPress: () => void mesh.refresh(),
        },
      ]}
    >
      <ScrollView
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={<RefreshControl refreshing={pulled} onRefresh={pull} />}
      >
        <MeshMachinesView
          state={mesh.state}
          now={mesh.state.now}
          paired={paired}
          certificateWarning={mesh.alias ? clientCertificateWarning(mesh.status) : null}
          onOpen={open}
          onPair={pair}
          onChooseCertificate={() => void mesh.chooseCertificate()}
          onRetry={() => void mesh.refresh()}
        />
      </ScrollView>
    </SettingsScreen>
  );
}
