import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useAtomSet } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { clientCertificateWarning } from "../../lib/clientCertificateExpiry";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { useHomeListOptions } from "../home/home-list-options";
import { useSelectWorkspaceTab } from "../layout/workspace/useSelectWorkspaceTab";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { pairedEnvironmentsByMachine } from "./meshEnvironments";
import type { MeshMachine } from "./meshMachines";
import { meshPairingOriginAtom } from "./meshPairingPrefill";
import { MeshDiagnosticsView } from "./MeshDiagnosticsView";
import { meshDiagnosticsRunner, pairedMeshDiagnosticTargets } from "./meshDiagnosticsSocket";
import { MeshEnrollmentView } from "./MeshEnrollmentView";
import { MeshFleetView } from "./MeshFleetView";
import { MeshMachinesView } from "./MeshMachinesView";
import { MESH_ROUTE_TITLE } from "./meshSettingsRow";
import { LOCAL_NETWORK_DENIED } from "./localNetworkLogic";
import { useLocalNetworkAccess } from "./useLocalNetworkAccess";
import { useMeshEnrollment } from "./useMeshEnrollment";
import { useMeshFleet } from "./useMeshFleet";
import { useMeshMachines } from "./useMeshMachines";

/**
 * Settings > Mesh: the machines the hub lists for this phone's identity, a read-only fleet
 * status for them, and this device's enrolled identity.
 */
export function MeshRouteScreen() {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const selectWorkspaceTab = useSelectWorkspaceTab();
  const { setSelectedEnvironmentId, setSelectedProjectKey } = useHomeListOptions(new Set());
  const insets = useSafeAreaInsets();
  const { connectedEnvironments } = useRemoteConnections();
  const setMeshPairingOrigin = useAtomSet(meshPairingOriginAtom);
  const mesh = useMeshMachines();
  const [screen, setScreen] = useState<"machines" | "fleet" | "device" | "device-enrollment">(
    "machines",
  );
  const tab = screen === "device-enrollment" ? "device" : screen;
  const focused = useIsFocused();
  const fleet = useMeshFleet({ focused: focused && tab !== "device" });
  const enrollment = useMeshEnrollment();
  const localNetwork = useLocalNetworkAccess();
  const askLocalNetwork = localNetwork.ask;
  const enrolled = enrollment.state.status !== null;
  // The direct connection and the home LAN need Android 17's local network permission; this is the
  // first moment an enrolled device is about to use them, so the person is asked here, once.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the system for a permission; the answer is held natively
  useEffect(() => {
    if (focused && enrolled) void askLocalNetwork("mesh-screen");
  }, [focused, enrolled, askLocalNetwork]);
  const [pulled, setPulled] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const paired = pairedEnvironmentsByMachine(mesh.state.machines ?? [], connectedEnvironments);

  const refresh = () => {
    if (tab === "device") return enrollment.refresh();
    if (tab === "fleet") return fleet.refresh();
    return Promise.all([mesh.refresh(), fleet.refresh()]);
  };
  const pull = () => {
    setPulled(true);
    void refresh().finally(() => setPulled(false));
  };
  // Pairing stays manual: the form opens with the viewer's address and waits for the code.
  const pair = (machine: MeshMachine) => {
    setMeshPairingOrigin(machine.viewerOrigin);
    navigation.navigate("SettingsEnvironmentNew", { meshPairingOrigin: machine.viewerOrigin });
  };
  const open = (environmentId: EnvironmentId) => {
    setSelectedProjectKey(null);
    setSelectedEnvironmentId(environmentId);
    selectWorkspaceTab("threads");
  };
  const openSettings = (environmentId: EnvironmentId) =>
    navigation.navigate("SettingsEnvironmentDetail", { environmentId });

  return (
    <SettingsScreen
      title={m(MESH_ROUTE_TITLE)}
      menus={[
        {
          title: gt("Mesh options"),
          icon: "ellipsis.circle",
          items: [
            {
              id: "diagnostics",
              title: gt("Diagnostics"),
              onPress: () => setShowDiagnostics(true),
            },
          ],
        },
      ]}
      actions={[
        {
          accessibilityLabel:
            tab === "device"
              ? gt("Refresh enrollment")
              : tab === "fleet"
                ? gt("Refresh fleet")
                : gt("Refresh machines"),
          icon: "arrow.clockwise",
          disabled:
            tab === "device"
              ? enrollment.state.busy !== null
              : fleet.state.loading || (tab === "machines" && mesh.state.loading),
          onPress: () => void refresh(),
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
        {enrolled && localNetwork.state === "denied" ? (
          <View className="gap-2 pb-3" accessibilityLabel={gt("Local network access denied")}>
            <Text className="text-sm text-danger-foreground">{m(LOCAL_NETWORK_DENIED)}</Text>
            <View className="flex-row">
              <Button
                tone="secondary"
                size="compact"
                label={gt("Settings", { $context: "button that opens the system app settings" })}
                onPress={localNetwork.openSettings}
              />
            </View>
          </View>
        ) : null}
        <View className="pb-3">
          <SegmentedControl
            variant="standalone"
            options={[
              { value: "machines", label: gt("Machines", { $context: "Mesh screen tab" }) },
              { value: "fleet", label: gt("Fleet", { $context: "Mesh screen tab" }) },
              { value: "device", label: gt("Device", { $context: "Mesh screen tab" }) },
            ]}
            selected={tab}
            onSelect={setScreen}
          />
        </View>
        {tab === "device" ? (
          <MeshEnrollmentView
            state={enrollment.state}
            startWithForm={screen === "device-enrollment"}
            onEnroll={async (identity, token) => {
              const success = await enrollment.enroll(identity, token);
              if (success && identity === enrollment.state.status?.identity) void mesh.refresh();
              return success;
            }}
            onRenew={() => void enrollment.renew()}
            onRemove={() => void enrollment.remove()}
          />
        ) : tab === "fleet" ? (
          <MeshFleetView
            state={fleet.state}
            certificateWarning={
              fleet.alias ? clientCertificateWarning(fleet.status, undefined, m) : null
            }
            onChooseCertificate={() => void fleet.chooseCertificate()}
            onRetry={() => void fleet.refresh()}
          />
        ) : (
          <MeshMachinesView
            state={mesh.state}
            now={Math.max(mesh.state.now, fleet.state.now)}
            fleet={fleet.state.problem === null ? fleet.state.fleet : null}
            fleetCheckedAt={
              fleet.state.problem === null && fleet.state.fleet ? fleet.state.now : null
            }
            paired={paired}
            certificateWarning={
              mesh.alias ? clientCertificateWarning(mesh.status, undefined, m) : null
            }
            enrollment={enrollment.state.status}
            onOpen={open}
            onSettings={openSettings}
            onPair={pair}
            onChooseCertificate={() => void mesh.chooseCertificate()}
            onEnroll={enrollment.state.available ? () => setScreen("device-enrollment") : undefined}
            onRetry={() => void refresh()}
          />
        )}
      </ScrollView>
      {showDiagnostics ? (
        <MeshDiagnosticsView
          runner={meshDiagnosticsRunner}
          getTargets={pairedMeshDiagnosticTargets}
          onClose={() => setShowDiagnostics(false)}
        />
      ) : null}
    </SettingsScreen>
  );
}
