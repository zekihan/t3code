import { useGT, useMessages } from "gt-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { SettingsSection } from "../settings/components/SettingsSection";
import { describeViewerReason } from "./meshDirectLogic";
import {
  directCheck,
  PROBE_FAILURES,
  type createMeshDiagnosticsRunner,
  type DiagnosticCheck,
  type DiagnosticTarget,
  type MeshDiagnostics,
} from "./meshDiagnostics";
import { MESH_HUB_URL } from "./meshViewerUrl";
import {
  formatDecisionEntry,
  meshDiagnosticsReport,
  trustAgeMinutes,
} from "./meshDiagnosticsReport";

function CheckRow({ label, check }: { readonly label: string; readonly check: DiagnosticCheck }) {
  const gt = useGT();
  const m = useMessages();
  const statuses = { pass: gt("Pass"), fail: gt("Fail"), skipped: gt("Skipped") };
  const details: Readonly<Record<string, string>> = {
    ok: gt("Completed successfully."),
    unsupported: gt("Not available on this device."),
    "factory-installed": gt("The certificate transport owns the OkHttp factory."),
    "factory-replaced": gt("The certificate transport no longer owns the OkHttp factory."),
    "no-certificate": gt("No hub certificate selected."),
    direct: gt("Direct ({network})", { network: "LAN" }),
    "socket-opened": gt("Opened and closed without sending any T3 messages."),
    "socket-prepare-failed": gt("Could not prepare the WebSocket connection."),
    "socket-failed": gt("The WebSocket could not open."),
    "socket-timeout": gt("The WebSocket did not open in time."),
    "no-socket-route": gt("No saved route to test."),
    stale: gt("The route or network changed during the probe."),
    unexpected: gt("The check could not complete."),
  };
  const detail =
    check.detail ??
    (check.httpStatus === undefined
      ? (describeViewerReason(check.code, m) ??
        (PROBE_FAILURES.includes(check.code) && check.code !== "unexpected"
          ? check.code
          : details[check.code]))
      : gt("The hub answered HTTP {status}.", { status: String(check.httpStatus) }));
  return (
    <View className="gap-0.5">
      <View className="flex-row flex-wrap items-baseline justify-between gap-x-3">
        <Text className="text-base text-foreground">{label}</Text>
        <Text
          className={
            check.state === "fail"
              ? "text-sm text-danger-foreground"
              : "text-sm text-foreground-muted"
          }
        >
          {statuses[check.state]}
        </Text>
      </View>
      {detail ? <Text className="text-sm text-foreground-muted">{detail}</Text> : null}
    </View>
  );
}

export function MeshDiagnosticsView({
  runner,
  getTargets,
  onClose,
}: {
  readonly runner: ReturnType<typeof createMeshDiagnosticsRunner>;
  readonly getTargets: () => readonly DiagnosticTarget[];
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const request = useRef<AbortController | null>(null);
  const [report, setReport] = useState<MeshDiagnostics | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [shareFailed, setShareFailed] = useState(false);

  const run = useCallback(() => {
    const controller = new AbortController();
    request.current = controller;
    void runner.run(getTargets(), controller.signal).then((next) => {
      if (!controller.signal.aborted) setReport(next);
    });
  }, [getTargets, runner]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens a network and native diagnostics run, cancelled when the view closes
  useEffect(() => {
    run();
    return () => request.current?.abort();
  }, [run]);

  const rerun = () => {
    request.current?.abort();
    setReport(null);
    setShareFailed(false);
    run();
  };

  const test = async (origin: string) => {
    const signal = request.current?.signal;
    setTesting(origin);
    const { log, ...updated } = await runner.test(origin);
    if (signal?.aborted) return;
    setReport(
      (previous) =>
        previous && {
          ...previous,
          log,
          paired: previous.paired.map((machine) =>
            machine.origin === origin ? { ...machine, ...updated } : machine,
          ),
        },
    );
    setTesting(null);
  };

  const share = async () => {
    if (!report) return;
    setShareFailed(false);
    try {
      await Share.share({ message: meshDiagnosticsReport(report) });
    } catch {
      setShareFailed(true);
    }
  };

  const record = (value: { readonly result: string; readonly at: number } | null) =>
    value ? `${value.result} · ${new Date(value.at).toLocaleString()}` : gt("No result yet");
  const log = report?.log.flatMap((entry) => {
    const line = formatDecisionEntry(entry);
    return line === null ? [] : [line];
  });

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <View
        className="flex-1 bg-sheet"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <SheetHeader
          presentation="inline"
          title={gt("Diagnostics")}
          onClose={onClose}
          actions={[
            {
              accessibilityLabel: gt("Refresh"),
              icon: "arrow.clockwise",
              disabled: report === null || testing !== null,
              onPress: rerun,
            },
            {
              accessibilityLabel: gt("Share report"),
              icon: "square.and.arrow.up",
              disabled: report === null || testing !== null,
              onPress: () => void share(),
            },
          ]}
        />
        <ScreenScrollView className="flex-1" contentContainerClassName="gap-4 px-5 py-4">
          {report === null ? (
            <Text accessibilityLiveRegion="polite">{gt("Running checks…")}</Text>
          ) : (
            <>
              {shareFailed ? (
                <Text className="text-danger-foreground">{gt("Could not share the report.")}</Text>
              ) : null}
              <SettingsSection title={new URL(MESH_HUB_URL).hostname}>
                <View className="gap-3 p-4">
                  <CheckRow
                    label={gt("React Native certificate transport")}
                    check={report.transport}
                  />
                  <CheckRow label="/api/v1/machines" check={report.machines} />
                  <CheckRow label="/api/v1/fleet" check={report.fleet} />
                </View>
              </SettingsSection>
              {report.paired.length === 0 ? <Text>{gt("No paired mesh machines.")}</Text> : null}
              {report.paired.map(({ environmentId, origin, direct, socket, test: result }) => (
                <SettingsSection
                  key={`${environmentId}:${origin}`}
                  title={new URL(origin).hostname}
                >
                  <View className="gap-3 p-4">
                    <CheckRow label={gt("Direct path")} check={directCheck(direct)} />
                    {direct ? (
                      <View className="gap-1">
                        {direct.trustFetchedAt === null ? (
                          <Text className="text-sm text-foreground-muted">
                            {gt("No trust information from the hub yet.")}
                          </Text>
                        ) : (
                          <Text className="text-sm text-foreground-muted">
                            {gt("Trust bundle age: {minutes} min", {
                              minutes: trustAgeMinutes(direct.trustFetchedAt, report.at),
                            })}
                          </Text>
                        )}
                        <Text className="text-sm text-foreground-muted">
                          {gt("Last home check: {result}", { result: record(direct.homeCheck) })}
                        </Text>
                        <Text className="text-sm text-foreground-muted">
                          {gt("Last direct probe: {result}", { result: record(direct.probe) })}
                        </Text>
                      </View>
                    ) : null}
                    <CheckRow label="WebSocket" check={socket} />
                    {result ? (
                      <CheckRow label={gt("On-demand direct probe")} check={result} />
                    ) : null}
                    <View className="self-start">
                      <Button
                        label={gt("Test direct path now")}
                        tone="secondary"
                        size="compact"
                        disabled={direct === null || testing !== null}
                        loading={testing === origin}
                        onPress={() => void test(origin)}
                      />
                    </View>
                  </View>
                </SettingsSection>
              ))}
              <SettingsSection title={gt("Recent direct-path decisions")}>
                <View className="gap-1 p-4">
                  {log?.length ? (
                    <Text selectable className="text-xs text-foreground-muted">
                      {log.join("\n")}
                    </Text>
                  ) : (
                    <Text className="text-sm text-foreground-muted">{gt("No result yet")}</Text>
                  )}
                </View>
              </SettingsSection>
            </>
          )}
        </ScreenScrollView>
      </View>
    </Modal>
  );
}
