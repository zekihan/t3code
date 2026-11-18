import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { clientCertificateWarning } from "../../lib/clientCertificateExpiry";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { pairedEnvironmentsByMachine } from "./meshEnvironments";
import type { MeshMachine } from "./meshMachines";
import { MeshEnrollmentView } from "./MeshEnrollmentView";
import { MeshFleetView } from "./MeshFleetView";
import { MeshMachinesView } from "./MeshMachinesView";
import { useMeshEnrollment } from "./useMeshEnrollment";
import { useMeshFleet } from "./useMeshFleet";
import { useMeshMachines } from "./useMeshMachines";

/**
 * Settings > Mesh: the machines the hub lists for this phone's identity, a read-only fleet
 * status for them, and this device's enrolled identity.
 */
export function MeshRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { connectedEnvironments, onChangeConnectionPairingUrl } = useRemoteConnections();
  const mesh = useMeshMachines();
  const [tab, setTab] = useState<"machines" | "fleet" | "device">("machines");
  const focused = useIsFocused();
  const fleet = useMeshFleet({ focused: focused && tab === "fleet" });
  const enrollment = useMeshEnrollment();
  const [pulled, setPulled] = useState(false);
  const paired = pairedEnvironmentsByMachine(mesh.state.machines ?? [], connectedEnvironments);

  const pull = () => {
    setPulled(true);
    void (tab === "device" ? enrollment : tab === "fleet" ? fleet : mesh)
      .refresh()
      .finally(() => setPulled(false));
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
          accessibilityLabel:
            tab === "device"
              ? "Refresh enrollment"
              : tab === "fleet"
                ? "Refresh fleet"
                : "Refresh machines",
          icon: "arrow.clockwise",
          disabled:
            tab === "device"
              ? enrollment.state.busy !== null
              : (tab === "fleet" ? fleet : mesh).state.loading,
          onPress: () =>
            void (tab === "device" ? enrollment : tab === "fleet" ? fleet : mesh).refresh(),
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
        <View className="pb-3">
          <SegmentedControl
            variant="standalone"
            options={[
              { value: "machines", label: "Machines" },
              { value: "fleet", label: "Fleet" },
              { value: "device", label: "Device" },
            ]}
            selected={tab}
            onSelect={setTab}
          />
        </View>
        {tab === "device" ? (
          <MeshEnrollmentView
            state={enrollment.state}
            onEnroll={enrollment.enroll}
            onRenew={() => void enrollment.renew()}
            onRemove={() => void enrollment.remove()}
          />
        ) : tab === "fleet" ? (
          <MeshFleetView
            state={fleet.state}
            certificateWarning={fleet.alias ? clientCertificateWarning(fleet.status) : null}
            onChooseCertificate={() => void fleet.chooseCertificate()}
            onRetry={() => void fleet.refresh()}
          />
        ) : (
          <MeshMachinesView
            state={mesh.state}
            now={mesh.state.now}
            paired={paired}
            certificateWarning={mesh.alias ? clientCertificateWarning(mesh.status) : null}
            onOpen={open}
            onPair={pair}
            onChooseCertificate={() => void mesh.chooseCertificate()}
            onEnroll={enrollment.state.available ? () => setTab("device") : undefined}
            onRetry={() => void mesh.refresh()}
          />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
