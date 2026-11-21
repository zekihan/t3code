import type { EnvironmentId } from "@t3tools/contracts";
import { msg, T, useGT, useLocale, useMessages } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Notice } from "../../components/ui/Notice";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import type { MessageResolver } from "../../i18n/messages";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import { describePathLabel } from "./meshDirectLogic";
import type { EnrollmentStatus } from "./meshEnrollment.types";
import { describeMeshIdentityWarning } from "./meshEnrollmentLogic";
import { formatServiceUnavailable, type MeshFleet, type MeshServiceHealth } from "./meshFleet";
import { formatLastSeen, type MeshMachine } from "./meshMachines";
import { problemDetail, problemTitle } from "./meshProblem";
import { useMeshDirect } from "./useMeshDirect";
import type { MeshState } from "./useMeshMachines";

export interface MeshMachinesViewProps {
  readonly state: MeshState;
  readonly now: number;
  readonly fleet: MeshFleet | null;
  readonly fleetCheckedAt: number | null;
  /** The machine's paired environment, when there is one. */
  readonly paired: ReadonlyMap<string, EnvironmentId>;
  readonly certificateWarning: string | null;
  readonly enrollment: EnrollmentStatus | null;
  readonly onOpen: (environmentId: EnvironmentId) => void;
  readonly onSettings: (environmentId: EnvironmentId) => void;
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

function describeLastList(checkedAt: number | null, now: number, resolve: MessageResolver) {
  if (checkedAt === null) return resolve(msg("Showing the last list. Its age is unknown."));
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60_000);
  if (minutes < 1) return resolve(msg("Showing the last list from less than a minute ago."));
  if (minutes < 60)
    return resolve(msg("Showing the last list from {count}m ago.", { count: minutes }));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return resolve(msg("Showing the last list from {count}h ago.", { count: hours }));
  return resolve(
    msg("Showing the last list from {count}d ago.", { count: Math.floor(hours / 24) }),
  );
}

function MachineStatus(props: {
  readonly origin: string;
  readonly service: MeshServiceHealth | undefined;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const direct = useMeshDirect(props.origin);
  const service = props.service;
  const health =
    service?.state === "reachable"
      ? gt("T3 reachable")
      : service?.state === "unreachable"
        ? formatServiceUnavailable(service.since, props.now, m)
        : gt("T3 status unknown");
  return (
    <Text className="text-sm text-foreground-muted">
      {health}
      {" · "}
      {direct ? describePathLabel(direct, m) : gt("Connection path unknown")}
    </Text>
  );
}

export function MeshMachinesView(props: MeshMachinesViewProps) {
  const gt = useGT();
  const m = useMessages();
  const problem = props.state.problem;
  const identityWarning = describeMeshIdentityWarning(
    props.enrollment,
    problem?.kind === "refused" ? problem.credential : undefined,
    m,
  );
  const warning = identityWarning?.message ?? props.certificateWarning;
  return (
    <View className="gap-3">
      {warning && (identityWarning || meshViewKind(props.state) === "list") ? (
        <View className="gap-2">
          <Notice
            message={warning}
            tone={identityWarning ? "danger" : "default"}
            icon="exclamationmark.triangle"
          />
          {identityWarning && props.onEnroll ? (
            <View className="flex-row">
              <Button
                tone="secondary"
                size="compact"
                label={gt("Re-enroll")}
                onPress={props.onEnroll}
              />
            </View>
          ) : null}
        </View>
      ) : null}
      <MachinesContent {...props} identityRefused={identityWarning?.kind === "refused"} />
    </View>
  );
}

function MachinesContent(props: MeshMachinesViewProps & { readonly identityRefused: boolean }) {
  const { state } = props;
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
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
  const identityProblemCovered =
    props.identityRefused &&
    (state.problem?.kind === "refused" || state.problem?.kind === "no-certificate");
  if (identityProblemCovered && (kind === "refused" || kind === "no-certificate")) return null;
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
  const fleetByOrigin = new Map(
    props.fleet?.machines.map((machine) => [machine.viewerOrigin, machine]),
  );
  const isLastList = state.fromCache || state.problem !== null;
  const lastList = isLastList ? describeLastList(state.checkedAt, props.now, m) : null;
  const formatCheckedAt = (at: number) =>
    new Date(at).toLocaleString(locale, {
      dateStyle: "short",
      timeStyle: "short",
    });
  return (
    <View className="gap-3">
      {state.problem && !identityProblemCovered ? (
        <Notice
          tone="danger"
          icon="exclamationmark.triangle"
          message={gt("{title}. {detail}", {
            title: problemTitle(state.problem.kind, m),
            detail: problemDetail(state.problem, m),
          })}
        />
      ) : null}
      {lastList ? <Text className="px-1 text-sm text-foreground-muted">{lastList}</Text> : null}
      {state.checkedAt !== null && !isLastList ? (
        <Text className="px-1 text-xs text-foreground-muted">
          {gt("Machine list checked {time}", { time: formatCheckedAt(state.checkedAt) })}
        </Text>
      ) : null}
      {props.fleetCheckedAt !== null ? (
        <Text className="px-1 text-xs text-foreground-muted">
          {gt("T3 status checked {time}", { time: formatCheckedAt(props.fleetCheckedAt) })}
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
                  <MachineStatus
                    origin={machine.viewerOrigin}
                    service={fleetByOrigin.get(machine.viewerOrigin)?.services.t3}
                    now={props.now}
                  />
                  <Text className="text-sm text-foreground-muted">
                    {formatLastSeen(machine.lastSeen, props.now, m)}
                  </Text>
                  <Text selectable className="text-xs text-foreground-muted">
                    {machine.viewerOrigin}
                  </Text>
                </View>
                {environmentId !== undefined ? (
                  <View className="gap-2">
                    <Button
                      tone="secondary"
                      size="compact"
                      label={gt("Open", { $context: "verb, opens a paired machine" })}
                      accessibilityLabel={gt("Open {name}", { name: machine.name })}
                      onPress={() => props.onOpen(environmentId)}
                    />
                    <Button
                      tone="text"
                      size="compact"
                      label={gt("Settings")}
                      accessibilityLabel={gt("Settings for {name}", { name: machine.name })}
                      onPress={() => props.onSettings(environmentId)}
                    />
                  </View>
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
