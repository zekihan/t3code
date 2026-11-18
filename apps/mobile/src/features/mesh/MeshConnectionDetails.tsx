import { useIsFocused } from "@react-navigation/native";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  describeHubRequest,
  formatPath,
  formatTunnelUptime,
  type MeshFleetMachine,
} from "./meshFleet";
import { meshViewerOriginOf } from "./meshViewerUrl";
import { problemDetail } from "./meshProblem";
import { useMeshFleet, type MeshFleetState } from "./useMeshFleet";

/** The machine at `origin` in the latest fleet answer, or null. */
export function machineAtOrigin(state: MeshFleetState, origin: string): MeshFleetMachine | null {
  return state.fleet?.machines.find((machine) => machine.viewerOrigin === origin) ?? null;
}

/**
 * The two independent paths of a mesh environment: the machine's tunnel to the hub, and this
 * phone's request to the hub. Renders nothing until the hub lists the machine.
 */
export function MeshConnectionDetailsView(props: {
  readonly state: MeshFleetState;
  readonly origin: string;
}) {
  const { state } = props;
  const machine = machineAtOrigin(state, props.origin);
  if (machine === null) {
    // A missing certificate is Settings > Mesh's to explain; a refusal or outage is worth a line.
    if (state.fleet !== null || state.problem === null || state.problem.kind === "no-certificate") {
      return null;
    }
    return (
      <SettingsSection title="Mesh connection">
        <View className="p-4">
          <Text className="text-sm text-foreground-muted">
            {`Connection details unavailable. ${problemDetail(state.problem)}`}
          </Text>
        </View>
      </SettingsSection>
    );
  }
  const uptime = formatTunnelUptime(machine.connectedSince, state.now);
  const hub = state.request === null ? null : describeHubRequest(state.request);
  return (
    <SettingsSection title="Mesh connection">
      <View className="gap-3 p-4">
        <View className="gap-0.5">
          <Text className="text-base text-foreground">
            {machine.online ? "Tunnel up" : "Tunnel down"}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {`Tunnel path: ${formatPath(machine.tunnelPath)}${machine.online && uptime ? ` · ${uptime}` : ""}`}
          </Text>
          <Text className="text-xs text-foreground-muted">
            The machine's own tunnel to the hub.
          </Text>
        </View>
        {hub ? (
          <View className="gap-0.5">
            <Text className="text-base text-foreground">{hub.path}</Text>
            <Text className="text-sm text-foreground-muted">{hub.rtt}</Text>
            <Text className="text-xs text-foreground-muted">{hub.note}</Text>
          </View>
        ) : null}
        {state.problem ? (
          <Text className="text-xs text-danger-foreground">
            {`Could not refresh. ${problemDetail(state.problem)}`}
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}

function MeshConnectionDetailsLoader(props: { readonly origin: string }) {
  const { state } = useMeshFleet({ focused: useIsFocused() });
  return <MeshConnectionDetailsView state={state} origin={props.origin} />;
}

/**
 * Shown on an environment's detail screen. Only an environment on a mesh viewer host asks the
 * hub anything; any other environment renders nothing and makes no request.
 */
export function MeshConnectionDetails(props: { readonly displayUrl: string }) {
  const origin = meshViewerOriginOf(props.displayUrl);
  return origin === null ? null : <MeshConnectionDetailsLoader origin={origin} />;
}
