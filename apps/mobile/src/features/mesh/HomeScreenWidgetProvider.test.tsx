import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  active: true,
  appListeners: new Set<() => void>(),
  fetch: vi.fn(),
  publish: vi.fn(),
  usage: vi.fn(),
  usageRefresh: vi.fn(),
}));

vi.mock("../../lib/appState", async () => {
  const { useSyncExternalStore } = await import("react");
  const read = () => mocks.active;
  return {
    isAppActive: read,
    useAppActive: () =>
      useSyncExternalStore((listener) => {
        mocks.appListeners.add(listener);
        return () => {
          mocks.appListeners.delete(listener);
        };
      }, read),
  };
});
vi.mock("../../lib/clientCertificates", () => ({ chooseClientCertificate: vi.fn() }));
vi.mock("../../widgets/SubscriptionUsageCoordinator", () => ({
  SubscriptionUsageCoordinator: mocks.usage,
}));
vi.mock("../../widgets/useSubscriptionUsage", () => ({
  installSubscriptionUsageRefresh: mocks.usageRefresh,
}));
vi.mock("../../widgets/widgetTheme", () => ({ createWidgetTheme: () => ({}) }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => {
  const themeVariablesByAppearance = {};
  return {
    useAppearancePreferences: () => ({
      themeMode: "system",
      themeVariablesByAppearance,
      isReady: true,
    }),
  };
});
vi.mock("./useClientCertificateStatus", () => ({
  useClientCertificateStatus: () => ({ alias: "hub-id", status: null }),
}));
vi.mock("./useMeshEnrollment", () => ({
  useMeshEnrollment: () => ({ state: { loaded: true, status: null } }),
}));
vi.mock("./meshNetwork", () => ({ watchFleetRefreshTriggers: () => () => undefined }));
vi.mock("./meshHub", () => ({ fetchMeshFleet: mocks.fetch }));
vi.mock("./publishMeshFleetWidget", () => ({
  meshFleetWidgetEnabled: true,
  publishMeshFleetWidget: mocks.publish,
}));

import {
  HomeScreenWidgetProvider,
  installHomeScreenWidgetRefresh,
} from "./HomeScreenWidgetProvider";
import { parseMeshFleet } from "./meshFleet";
import { useMeshFleet } from "./useMeshFleet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setActive(value: boolean) {
  mocks.active = value;
  for (const listener of mocks.appListeners) listener();
}

const emptyFleet = { kind: "ok", rttMs: 10, fleet: { callerPath: "OCI", machines: [] } } as const;

it("publishes the shared fleet on refresh and foreground, and leaves the snapshot alone in the background", async () => {
  vi.clearAllMocks();
  mocks.active = true;
  mocks.fetch.mockResolvedValue(emptyFleet);
  const stopRefresh = installHomeScreenWidgetRefresh();
  const root = createRoot(document.createElement("div"));
  let refresh = () => Promise.resolve();
  function MeshScreen() {
    const fleet = useMeshFleet({ focused: false });
    useLayoutEffect(() => {
      refresh = fleet.refresh;
    }, [fleet.refresh]);
    return null;
  }
  try {
    await act(async () =>
      root.render(
        <HomeScreenWidgetProvider>
          <MeshScreen />
        </HomeScreenWidgetProvider>,
      ),
    );
    expect(mocks.usage).not.toHaveBeenCalled();
    expect(mocks.usageRefresh).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const first = mocks.publish.mock.lastCall?.[0];
    expect(first).toMatchObject({ fleet: "0/0 machines up", checkedAt: expect.any(Number) });

    mocks.fetch.mockResolvedValueOnce({ kind: "unavailable", message: "offline" });
    await act(async () => refresh());
    expect(mocks.publish.mock.lastCall?.[0]).toEqual(first);

    const fleet = parseMeshFleet({
      machines: [
        {
          name: "desktop",
          viewerUrl: "https://t3.desktop.mesh.noqer.com",
          online: true,
          services: { t3: { state: "reachable", since: null } },
        },
      ],
    });
    mocks.fetch.mockResolvedValueOnce({ ...emptyFleet, fleet });
    await act(async () => refresh());
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.publish.mock.lastCall?.[0]).toMatchObject({ fleet: "1/1 machines up" });

    let finish: (value: typeof emptyFleet) => void = () => undefined;
    mocks.fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => {
      void refresh();
    });
    await act(async () => setActive(false));
    mocks.publish.mockClear();
    await act(async () => finish(emptyFleet));
    expect(mocks.publish).not.toHaveBeenCalled();
    await act(async () => refresh());
    expect(mocks.fetch).toHaveBeenCalledTimes(4);

    await act(async () => setActive(true));
    expect(mocks.fetch).toHaveBeenCalledTimes(5);
    expect(mocks.publish.mock.lastCall?.[0]).toMatchObject({
      fleet: "0/0 machines up",
      checkedAt: expect.any(Number),
    });
  } finally {
    act(() => root.unmount());
    stopRefresh();
  }
});
