import { useIsFocused } from "@react-navigation/native";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SettingsSection } from "../settings/components/SettingsSection";
import type { DirectStatus } from "./meshDirect.types";
import {
  describeDirectFailure,
  describePathLabel,
  describePathReason,
  describeUnknownOutcome,
} from "./meshDirectLogic";
import {
  describeHubRequest,
  formatPath,
  formatTunnelUptime,
  type MeshFleetMachine,
} from "./meshFleet";
import { meshViewerOriginOf } from "./meshViewerUrl";
import { problemDetail } from "./meshProblem";
import { useMeshDirect } from "./useMeshDirect";
import { useMeshFleet, type MeshFleetState } from "./useMeshFleet";

/** The machine at `origin` in the latest fleet answer, or null. */
export function machineAtOrigin(state: MeshFleetState, origin: string): MeshFleetMachine | null {
  return state.fleet?.machines.find((machine) => machine.viewerOrigin === origin) ?? null;
}

/**
 * The path this phone's requests to the environment take: direct over the LAN, or the viewer host.
 * A certificate or authorization failure on the direct path shows here even while the viewer host
 * carries the traffic.
 */
function EnvironmentPath(props: { readonly direct: DirectStatus }) {
  const { direct } = props;
  const reason = describePathReason(direct);
  const unreachable = direct.path === "viewer" ? direct.unreachable : null;
  return (
    <View className="gap-0.5">
      <Text className="text-base text-foreground">
        {`Connection path: ${describePathLabel(direct)}`}
      </Text>
      {reason ? <Text className="text-sm text-foreground-muted">{reason}</Text> : null}
      {unreachable ? (
        <Text className="text-xs text-foreground-muted">{unreachable.detail}</Text>
      ) : null}
      {direct.failure ? (
        <Text className="text-sm text-danger-foreground">
          {describeDirectFailure(direct.failure)}
        </Text>
      ) : null}
      {direct.unknownOutcome ? (
        <Text className="text-sm text-danger-foreground">
          {describeUnknownOutcome(direct.unknownOutcome)}
        </Text>
      ) : null}
      <Text className="text-xs text-foreground-muted">
        The route this phone's requests to the machine take; the machine's tunnel is separate.
      </Text>
    </View>
  );
}

/**
 * The paths of a mesh environment: the one this phone's requests take (direct or viewer host),
 * the machine's tunnel to the hub, and this phone's request to the hub. The tunnel and hub
 * request show once the hub lists the machine; the path shows whenever the phone knows it.
 */
export function MeshConnectionDetailsView(props: {
  readonly state: MeshFleetState;
  readonly origin: string;
  readonly direct?: DirectStatus | null;
}) {
  const { state, direct = null } = props;
  const machine = machineAtOrigin(state, props.origin);
  if (machine === null) {
    // A missing certificate is Settings > Mesh's to explain; a refusal or outage is worth a line.
    const unavailable =
      state.fleet === null && state.problem !== null && state.problem.kind !== "no-certificate";
    if (!unavailable && direct === null) return null;
    return (
      <SettingsSection title="Mesh connection">
        <View className="gap-3 p-4">
          {direct ? <EnvironmentPath direct={direct} /> : null}
          {unavailable && state.problem ? (
            <Text className="text-sm text-foreground-muted">
              {`Connection details unavailable. ${problemDetail(state.problem)}`}
            </Text>
          ) : null}
        </View>
      </SettingsSection>
    );
  }
  const uptime = formatTunnelUptime(machine.connectedSince, state.now);
  const hub = state.request === null ? null : describeHubRequest(state.request);
  return (
    <SettingsSection title="Mesh connection">
      <View className="gap-3 p-4">
        {direct ? <EnvironmentPath direct={direct} /> : null}
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
  const direct = useMeshDirect(props.origin);
  return <MeshConnectionDetailsView state={state} origin={props.origin} direct={direct} />;
}

/**
 * Shown on an environment's detail screen. Only an environment on a mesh viewer host asks the
 * hub anything; any other environment renders nothing and makes no request.
 */
export function MeshConnectionDetails(props: { readonly displayUrl: string }) {
  const origin = meshViewerOriginOf(props.displayUrl);
  return origin === null ? null : <MeshConnectionDetailsLoader origin={origin} />;
}
