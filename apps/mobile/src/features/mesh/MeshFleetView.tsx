import { T, useGT, useMessages } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { Notice } from "../../components/ui/Notice";
import { cn } from "../../lib/cn";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import {
  describeHubRequest,
  formatAlert,
  formatCertificateExpiry,
  formatPath,
  formatServiceCheck,
  formatTunnelUptime,
  type MeshFleetMachine,
} from "./meshFleet";
import { formatLastSeen } from "./meshMachines";
import { problemDetail, problemTitle } from "./meshProblem";
import type { MeshFleetState } from "./useMeshFleet";

export interface MeshFleetViewProps {
  readonly state: MeshFleetState;
  readonly certificateWarning: string | null;
  readonly onChooseCertificate: () => void;
  readonly onRetry: () => void;
}

/** What the screen shows for a state; the view and its tests share it. */
export function meshFleetViewKind(state: MeshFleetState) {
  if (state.fleet === null || state.fleet.machines.length === 0) {
    if (state.problem !== null) return state.problem.kind;
    return state.fleet === null || state.loading ? ("loading" as const) : ("empty" as const);
  }
  return "list" as const;
}

/** The phone's hub request: its path and round-trip time, labelled as that request's. */
export function HubRequestSummary(props: { readonly state: MeshFleetState }) {
  const m = useMessages();
  if (props.state.request === null) return null;
  const hub = describeHubRequest(props.state.request, m);
  return (
    <View className="gap-0.5 rounded-[26px] border-continuous bg-grouped-card px-4 py-3">
      <Text textRole="body" className="text-foreground">
        {hub.path}
      </Text>
      <Text className="text-sm text-foreground">{hub.rtt}</Text>
      <Text className="text-xs text-foreground-muted">{hub.note}</Text>
    </View>
  );
}

function FleetMachineRow(props: { readonly machine: MeshFleetMachine; readonly now: number }) {
  const { machine, now } = props;
  const gt = useGT();
  const m = useMessages();
  const uptime = formatTunnelUptime(machine.connectedSince, now, m);
  const expiry = formatCertificateExpiry(machine.certNotAfter, now, m);
  const path = formatPath(machine.tunnelPath, m);
  return (
    <View className="gap-1 px-4 py-3">
      <View className="flex-row items-center gap-3">
        <ConnectionStatusDot state={machine.online ? "connected" : "available"} pulse={false} />
        <Text textRole="body" className="min-w-0 flex-1 text-foreground">
          {machine.name}
          <Text className="text-sm text-foreground-muted">
            {`  ${machine.online ? gt("Tunnel up") : gt("Tunnel down")}`}
          </Text>
        </Text>
      </View>
      <View className="gap-0.5 pl-6">
        {machine.online ? (
          <Text className="text-sm text-foreground-muted">
            {uptime
              ? gt("Tunnel path: {path} · {uptime}", { path, uptime })
              : gt("Tunnel path: {path}", { path })}
          </Text>
        ) : (
          <Text className="text-sm text-foreground-muted">
            {formatLastSeen(machine.lastSeen, now, m)}
          </Text>
        )}
        {machine.online && machine.services.t3?.state === "unreachable" ? (
          <Text className="text-sm text-danger-foreground">
            {gt("T3 unavailable")}
            {machine.services.t3.checkedAt !== null
              ? ` · ${formatServiceCheck(machine.services.t3.checkedAt, now, m)}`
              : null}
          </Text>
        ) : null}
        <Text className="text-sm text-foreground-muted">
          {machine.agentVersion
            ? gt("Agent {version}", { version: machine.agentVersion })
            : gt("Agent version unknown")}
        </Text>
        <Text
          className={cn(
            "text-sm",
            expiry.warn ? "text-danger-foreground" : "text-foreground-muted",
          )}
        >
          {expiry.label}
        </Text>
        {machine.alerts.length > 0 ? (
          <View className="flex-row flex-wrap gap-1.5 pt-1.5">
            {machine.alerts.map((alert) => (
              <Chip
                key={alert}
                size="small"
                icon="exclamationmark.triangle"
                label={formatAlert(alert, m)}
              />
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function MeshFleetView(props: MeshFleetViewProps) {
  const { state } = props;
  const gt = useGT();
  const m = useMessages();
  const kind = meshFleetViewKind(state);
  if (kind === "loading") {
    return (
      <View className="items-center gap-3 px-8 py-12" accessibilityLabel={gt("Loading fleet")}>
        <AppActivityIndicator />
        <Text className="text-foreground-muted">
          <T>Loading fleet</T>
        </Text>
      </View>
    );
  }
  if (kind === "no-certificate" || kind === "refused" || kind === "unavailable") {
    return (
      <EmptyState
        variant="plain"
        title={problemTitle(kind, m)}
        detail={problemDetail(state.problem!, m)}
        actionLabel={kind === "unavailable" ? gt("Try again") : gt("Select certificate")}
        onAction={kind === "unavailable" ? props.onRetry : props.onChooseCertificate}
      />
    );
  }
  if (kind === "empty") {
    return (
      <EmptyState
        variant="plain"
        title={gt("No machines")}
        detail={gt("The hub lists no machines for this certificate.")}
        actionLabel={gt("Refresh")}
        onAction={props.onRetry}
      />
    );
  }
  const machines = state.fleet?.machines ?? [];
  return (
    <View className="gap-3">
      {props.certificateWarning ? (
        <Notice message={props.certificateWarning} icon="exclamationmark.triangle" />
      ) : null}
      {state.problem ? (
        <Notice
          tone="danger"
          icon="exclamationmark.triangle"
          message={gt("{title}. {detail} Showing the last status.", {
            title: problemTitle(state.problem.kind, m),
            detail: problemDetail(state.problem, m),
          })}
        />
      ) : null}
      <HubRequestSummary state={state} />
      <View className="overflow-hidden rounded-[26px] border-continuous bg-grouped-card">
        {machines.map((machine, index) => (
          <View key={machine.name}>
            {index > 0 ? <View className="ml-4 border-t border-border-subtle" /> : null}
            <FleetMachineRow machine={machine} now={state.now} />
          </View>
        ))}
      </View>
      <Text className="px-1 text-xs text-foreground-muted">
        <T>
          Tunnel up means the machine holds a live tunnel session with the hub. It does not mean T3
          itself is healthy.
        </T>
      </Text>
    </View>
  );
}
