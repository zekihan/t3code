import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
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
  const gt = useGT();
  const m = useMessages();
  const kind = meshViewKind(state);
  if (kind === "loading") {
    return (
      <View className="items-center gap-3 px-8 py-12" accessibilityLabel={gt("Loading machines")}>
        <AppActivityIndicator />
        <Text className="text-foreground-muted">
          <T>Loading machines</T>
        </Text>
      </View>
    );
  }
  if (kind === "no-certificate" || kind === "refused" || kind === "unavailable") {
    const problem = state.problem!;
    const enrollable = kind !== "unavailable" && props.onEnroll !== undefined;
    return (
      <EmptyState
        variant="plain"
        title={problemTitle(kind, m)}
        detail={problemDetail(problem, m)}
        actionLabel={kind === "unavailable" ? gt("Try again") : gt("Select certificate")}
        onAction={kind === "unavailable" ? props.onRetry : props.onChooseCertificate}
        action={
          enrollable ? (
            <View className="items-center gap-2">
              <Button
                tone="primary"
                label={gt("Select certificate")}
                onPress={props.onChooseCertificate}
              />
              <Button tone="text" label={gt("Enroll this device")} onPress={props.onEnroll!} />
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
        title={gt("No machines")}
        detail={gt("The hub lists no machines for this certificate.")}
        actionLabel={gt("Refresh")}
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
          message={gt("{title}. {detail} Showing the last list.", {
            title: problemTitle(state.problem.kind, m),
            detail: problemDetail(state.problem, m),
          })}
        />
      ) : null}
      {state.fromCache && !state.problem ? (
        <Text className="px-1 text-sm text-foreground-muted">
          <T>Showing the last list.</T>
        </Text>
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
                      {`  ${machine.online ? gt("Tunnel up") : gt("Tunnel down")}`}
                    </Text>
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    {formatLastSeen(machine.lastSeen, props.now, m)}
                  </Text>
                  <Text selectable className="text-xs text-foreground-muted">
                    {machine.viewerOrigin}
                  </Text>
                </View>
                {environmentId !== undefined ? (
                  <Button
                    tone="secondary"
                    size="compact"
                    label={gt("Open", { $context: "verb, opens a paired machine" })}
                    accessibilityLabel={gt("Open {name}", { name: machine.name })}
                    onPress={() => props.onOpen(environmentId)}
                  />
                ) : (
                  <Button
                    tone="primary"
                    size="compact"
                    label={gt("Pair", { $context: "verb, pairs a machine" })}
                    accessibilityLabel={gt("Pair {name}", { name: machine.name })}
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
