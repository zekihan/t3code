import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Notice } from "../../components/ui/Notice";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import { formatLastSeen, type MeshMachine } from "./meshMachines";
import { problemDetail, problemTitle } from "./meshProblem";
import type { MeshState } from "./useMeshMachines";

export interface MeshMachinesViewProps {
  readonly state: MeshState;
  readonly now: number;
  /** The machine's paired environment, when there is one. */
  readonly paired: ReadonlyMap<string, EnvironmentId>;
  readonly certificateWarning: string | null;
  readonly onOpen: (environmentId: EnvironmentId) => void;
  readonly onPair: (machine: MeshMachine) => void;
  readonly onChooseCertificate: () => void;
  /** Opens the Device tab. Offered next to the KeyChain picker when the hub has no identity for us. */
  readonly onEnroll?: () => void;
  readonly onRetry: () => void;
}

/** What the screen shows for a state; the view and its tests share it. */
export function meshViewKind(state: MeshState) {
  if (state.machines === null || state.machines.length === 0) {
    if (state.problem !== null) return state.problem.kind;
    return state.machines === null || state.loading ? ("loading" as const) : ("empty" as const);
  }
  return "list" as const;
}

export function MeshMachinesView(props: MeshMachinesViewProps) {
  const { state } = props;
  const kind = meshViewKind(state);
  if (kind === "loading") {
    return (
      <View className="items-center gap-3 px-8 py-12" accessibilityLabel="Loading machines">
        <AppActivityIndicator />
        <Text className="text-foreground-muted">Loading machines</Text>
      </View>
    );
  }
  if (kind === "no-certificate" || kind === "refused" || kind === "unavailable") {
    const problem = state.problem!;
    const enrollable = kind !== "unavailable" && props.onEnroll !== undefined;
    return (
      <EmptyState
        variant="plain"
        title={problemTitle(kind)}
        detail={problemDetail(problem)}
        actionLabel={kind === "unavailable" ? "Try again" : "Select certificate"}
        onAction={kind === "unavailable" ? props.onRetry : props.onChooseCertificate}
        action={
          enrollable ? (
            <View className="items-center gap-2">
              <Button
                tone="primary"
                label="Select certificate"
                onPress={props.onChooseCertificate}
              />
              <Button tone="text" label="Enroll this device" onPress={props.onEnroll!} />
            </View>
          ) : undefined
        }
      />
    );
  }
  if (kind === "empty") {
    return (
      <EmptyState
        variant="plain"
        title="No machines"
        detail="The hub lists no machines for this certificate."
        actionLabel="Refresh"
        onAction={props.onRetry}
      />
    );
  }
  const machines = state.machines ?? [];
  return (
    <View className="gap-3">
      {props.certificateWarning ? (
        <Notice message={props.certificateWarning} icon="exclamationmark.triangle" />
      ) : null}
      {state.problem ? (
        <Notice
          tone="danger"
          icon="exclamationmark.triangle"
          message={`${problemTitle(state.problem.kind)}. ${problemDetail(state.problem)} Showing the last list.`}
        />
      ) : null}
      {state.fromCache && !state.problem ? (
        <Text className="px-1 text-sm text-foreground-muted">Showing the last list.</Text>
      ) : null}
      <View className="overflow-hidden rounded-[26px] border-continuous bg-grouped-card">
        {machines.map((machine, index) => {
          const environmentId = props.paired.get(machine.name);
          return (
            <View key={machine.name}>
              {index > 0 ? <View className="ml-4 border-t border-border-subtle" /> : null}
              <View className="flex-row items-center gap-3 px-4 py-3">
                <ConnectionStatusDot
                  state={machine.online ? "connected" : "available"}
                  pulse={false}
                />
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text textRole="body" className="text-foreground">
                    {machine.name}
                    <Text className="text-sm text-foreground-muted">
                      {machine.online ? "  Tunnel up" : "  Tunnel down"}
                    </Text>
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    {formatLastSeen(machine.lastSeen, props.now)}
                  </Text>
                  <Text selectable className="text-xs text-foreground-muted">
                    {machine.viewerOrigin}
                  </Text>
                </View>
                {environmentId !== undefined ? (
                  <Button
                    tone="secondary"
                    size="compact"
                    label="Open"
                    accessibilityLabel={`Open ${machine.name}`}
                    onPress={() => props.onOpen(environmentId)}
                  />
                ) : (
                  <Button
                    tone="primary"
                    size="compact"
                    label="Pair"
                    accessibilityLabel={`Pair ${machine.name}`}
                    onPress={() => props.onPair(machine)}
                  />
                )}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}
