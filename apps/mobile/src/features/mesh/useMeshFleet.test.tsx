import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  alias: null as string | null,
  choose: vi.fn(),
  fetch: vi.fn(),
  watch: vi.fn(),
}));
vi.mock("../../lib/clientCertificates", () => ({
  clientCertificatesAvailable: true,
  chooseClientCertificate: mocks.choose,
}));
vi.mock("./useClientCertificateStatus", () => ({
  useClientCertificateStatus: () => ({ alias: mocks.alias, status: null }),
}));
vi.mock("./meshHub", () => ({ fetchMeshFleet: mocks.fetch }));
vi.mock("./meshNetwork", () => ({ watchFleetRefreshTriggers: mocks.watch }));

import { useMeshFleet } from "./useMeshFleet";
import { MESH_HUB_URL } from "./meshViewerUrl";
import type { MeshFleet } from "./meshFleet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latest: ReturnType<typeof useMeshFleet>;
function Probe(props: { focused: boolean }) {
  const value = useMeshFleet({ focused: props.focused });
  useLayoutEffect(() => {
    latest = value;
  });
  return null;
}

const fleetOn = (callerPath: "LAN" | "OCI" | null): MeshFleet => ({ callerPath, machines: [] });
const ok = (callerPath: "LAN" | "OCI" | null, rttMs: number) => ({
  kind: "ok" as const,
  fleet: fleetOn(callerPath),
  rttMs,
});

async function mount(focused: boolean) {
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe focused={focused} />));
  return {
    focus: (value: boolean) => act(async () => root.render(<Probe focused={value} />)),
    unmount: () => act(() => root.unmount()),
  };
}

let trigger: () => void;
const stopWatching = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  mocks.alias = "hub-id";
  mocks.fetch.mockResolvedValue(ok("LAN", 40));
  mocks.choose.mockResolvedValue("hub-id");
  mocks.watch.mockImplementation((onTrigger: () => void) => {
    trigger = onTrigger;
    return stopWatching;
  });
});

it("fetches on focus and reports the request's path and round-trip time together", async () => {
  const screen = await mount(true);
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(latest.state.request).toEqual({ path: "LAN", rttMs: 40 });
  expect(latest.state.fleet).toEqual(fleetOn("LAN"));
  expect(latest.state.loading).toBe(false);
  screen.unmount();
});

it("does nothing while unfocused, then fetches and watches the network once focused", async () => {
  const screen = await mount(false);
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.watch).not.toHaveBeenCalled();
  await screen.focus(true);
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(mocks.watch).toHaveBeenCalledOnce();
  await screen.focus(false);
  expect(stopWatching).toHaveBeenCalledOnce();
  screen.unmount();
});

it("measures again on a network change, so the path follows the network", async () => {
  const screen = await mount(true);
  expect(latest.state.request).toEqual({ path: "LAN", rttMs: 40 });
  mocks.fetch.mockResolvedValue(ok("OCI", 95));
  await act(async () => trigger());
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(latest.state.request).toEqual({ path: "OCI", rttMs: 95 });
  expect(latest.state.fleet?.callerPath).toBe("OCI");
  screen.unmount();
});

it("drops an answer that arrives after a newer request started", async () => {
  let resolveSlow: (value: unknown) => void = () => undefined;
  mocks.fetch.mockReturnValueOnce(new Promise((resolve) => (resolveSlow = resolve)));
  const screen = await mount(true);
  expect(latest.state.loading).toBe(true);
  mocks.fetch.mockResolvedValue(ok("OCI", 95));
  await act(async () => trigger());
  expect(latest.state.request).toEqual({ path: "OCI", rttMs: 95 });
  await act(async () => resolveSlow(ok("LAN", 10)));
  expect(latest.state.request).toEqual({ path: "OCI", rttMs: 95 });
  screen.unmount();
});

it("keeps the last fleet and its request when a refresh fails", async () => {
  const screen = await mount(true);
  mocks.fetch.mockResolvedValue({ kind: "refused", status: 403 });
  await act(async () => latest.refresh());
  expect(latest.state.problem).toEqual({ kind: "refused", status: 403 });
  expect(latest.state.fleet).toEqual(fleetOn("LAN"));
  expect(latest.state.request).toEqual({ path: "LAN", rttMs: 40 });
  mocks.fetch.mockResolvedValue({ kind: "unavailable", message: "no route" });
  await act(async () => latest.refresh());
  expect(latest.state.problem).toEqual({ kind: "unavailable", message: "no route" });
  mocks.fetch.mockResolvedValue({ kind: "no-certificate" });
  await act(async () => latest.refresh());
  expect(latest.state.problem).toEqual({ kind: "no-certificate", message: null });
  screen.unmount();
});

it("selects the hub's certificate on request and reports a failed selection", async () => {
  const screen = await mount(true);
  await act(async () => latest.chooseCertificate());
  expect(mocks.choose).toHaveBeenCalledWith(MESH_HUB_URL);
  mocks.choose.mockRejectedValue(new Error("Cancelled"));
  await act(async () => latest.chooseCertificate());
  expect(latest.state.problem).toEqual({ kind: "no-certificate", message: "Cancelled" });
  screen.unmount();
});

it("fetches again when the hub's certificate changes", async () => {
  const screen = await mount(true);
  mocks.alias = "other-id";
  await screen.focus(true);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  screen.unmount();
});
