import { useLocale, useMessages } from "gt-react-native";
import { useEffect, useState, type ReactNode } from "react";

import { useAppActive } from "../../lib/appState";
import { SubscriptionUsageCoordinator } from "../../widgets/SubscriptionUsageCoordinator";
import { installSubscriptionUsageRefresh } from "../../widgets/useSubscriptionUsage";
import { createWidgetTheme } from "../../widgets/widgetTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { getDirectStatus, onDirectChanged } from "./meshDirect";
import type { DirectStatus } from "./meshDirect.types";
import type { MeshFleet } from "./meshFleet";
import {
  buildMeshWidgetSnapshot,
  summarizeMeshWidgetPaths,
  type MeshWidgetPath,
} from "./meshWidgetSnapshot";
import { meshFleetWidgetEnabled, publishMeshFleetWidget } from "./publishMeshFleetWidget";
import { useMeshEnrollment } from "./useMeshEnrollment";
import { MeshFleetContext, useLocalMeshFleet } from "./useMeshFleet";

export function installHomeScreenWidgetRefresh() {
  return meshFleetWidgetEnabled ? () => undefined : installSubscriptionUsageRefresh();
}

export function HomeScreenWidgetProvider({ children }: { readonly children: ReactNode }) {
  return meshFleetWidgetEnabled ? (
    <MeshFleetWidgetProvider>{children}</MeshFleetWidgetProvider>
  ) : (
    <>
      <SubscriptionUsageCoordinator />
      {children}
    </>
  );
}

function MeshFleetWidgetProvider({ children }: { readonly children: ReactNode }) {
  const active = useAppActive();
  const fleet = useLocalMeshFleet({ focused: active, foregroundOnly: true });
  return (
    <MeshFleetContext value={fleet}>
      <MeshFleetWidgetPublisher active={active} state={fleet.state} />
      {children}
    </MeshFleetContext>
  );
}

function useMeshWidgetPath(fleet: MeshFleet | null, active: boolean) {
  const originKey =
    fleet?.machines
      .map(({ viewerOrigin }) => viewerOrigin)
      .sort()
      .join(" ") ?? "";
  const [path, setPath] = useState<MeshWidgetPath>("unknown");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- native decides direct routes independently of the hub's fleet data
  useEffect(() => {
    if (!active || !originKey) return;
    const origins = new Set(originKey.split(" "));
    let latest: Promise<(DirectStatus | null)[]> | undefined;
    const read = () => {
      const pending = Promise.all(
        [...origins].map((origin) => getDirectStatus(origin).catch(() => null)),
      );
      latest = pending;
      void pending.then((statuses) => {
        if (latest === pending) setPath(summarizeMeshWidgetPaths(statuses));
      });
    };
    const subscription = onDirectChanged(({ origin }) => {
      if (origins.has(origin)) read();
    });
    read();
    return () => {
      latest = undefined;
      subscription.remove();
    };
  }, [active, originKey]);

  return originKey ? path : "unknown";
}

function MeshFleetWidgetPublisher({
  active,
  state,
}: {
  readonly active: boolean;
  readonly state: ReturnType<typeof useLocalMeshFleet>["state"];
}) {
  const resolve = useMessages();
  const locale = useLocale();
  const { themeMode, themeAppearance, themeVariablesByAppearance, isReady } =
    useAppearancePreferences();
  const { state: enrollment } = useMeshEnrollment();
  const { fleet, checkedAt } = state;
  const path = useMeshWidgetPath(fleet, active);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the latest foreground mesh data and theme to the native widget snapshot
  useEffect(() => {
    if (!active || !isReady || !enrollment.loaded) return;
    const snapshot = buildMeshWidgetSnapshot(
      { fleet, checkedAt, enrollment: enrollment.status, path, now: Date.now(), locale },
      resolve,
    );
    void Promise.resolve(
      publishMeshFleetWidget({
        ...snapshot,
        theme: createWidgetTheme(themeMode, themeVariablesByAppearance),
      }),
    ).catch((error: unknown) => {
      console.warn("Could not update mesh fleet widget", error);
    });
  }, [
    active,
    checkedAt,
    enrollment.loaded,
    enrollment.status,
    fleet,
    isReady,
    locale,
    path,
    resolve,
    themeMode,
    themeVariablesByAppearance,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Android stores resolved colors, so System appearance changes must republish them.
    themeAppearance,
  ]);
  return null;
}
