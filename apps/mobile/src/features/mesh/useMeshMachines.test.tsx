import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  alias: null as string | null,
  choose: vi.fn(),
  fetch: vi.fn(),
  sync: vi.fn(),
  save: vi.fn(),
  load: vi.fn(),
}));
vi.mock("../../lib/clientCertificates", () => ({
  clientCertificatesAvailable: true,
  chooseClientCertificate: mocks.choose,
}));
vi.mock("./useClientCertificateStatus", () => ({
  useClientCertificateStatus: () => ({ alias: mocks.alias, status: null }),
}));
vi.mock("./meshHub", () => ({ fetchMeshMachines: mocks.fetch }));
vi.mock("./meshAliases", () => ({ nativeMeshAliasApi: {}, syncMeshAliases: mocks.sync }));
vi.mock("./meshStore", () => ({
  loadCachedMeshMachines: mocks.load,
  saveCachedMeshMachines: mocks.save,
}));

import { useMeshMachines } from "./useMeshMachines";
import { MESH_HUB_URL } from "./meshViewerUrl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latest: ReturnType<typeof useMeshMachines>;
function Probe() {
  const value = useMeshMachines();
  useLayoutEffect(() => {
    latest = value;
  });
  return null;
}

const machine = {
  name: "z-arch",
  online: true,
  lastSeen: null,
  viewerOrigin: "https://t3.z-arch.mesh.noqer.com",
};

async function open() {
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  return () => act(() => root.unmount());
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.alias = null;
  mocks.load.mockResolvedValue(null);
  mocks.sync.mockResolvedValue({});
  mocks.choose.mockResolvedValue("hub-id");
  mocks.fetch.mockResolvedValue({ kind: "ok", machines: [machine] });
});

it("asks for the hub identity on the first open, then lists and shares it with the machines", async () => {
  const unmount = await open();
  expect(mocks.choose).toHaveBeenCalledOnce();
  expect(mocks.choose).toHaveBeenCalledWith(MESH_HUB_URL);
  expect(latest.state.machines).toEqual([machine]);
  expect(mocks.sync).toHaveBeenCalledWith({}, [machine]);
  expect(mocks.save).toHaveBeenCalledWith([machine]);
  unmount();
});

it("does not show the picker when the hub already has an identity", async () => {
  mocks.alias = "hub-id";
  const unmount = await open();
  expect(mocks.choose).not.toHaveBeenCalled();
  expect(latest.state.machines).toEqual([machine]);
  unmount();
});

it("shows no-certificate with the picker's message and moves no alias when it fails", async () => {
  mocks.choose.mockRejectedValue(new Error("A certificate picker is already open."));
  mocks.fetch.mockResolvedValue({ kind: "no-certificate" });
  const unmount = await open();
  expect(latest.state.problem).toEqual({
    kind: "no-certificate",
    message: "A certificate picker is already open.",
  });
  expect(mocks.sync).not.toHaveBeenCalled();
  unmount();
});

it("leaves every alias alone when the hub refuses the identity", async () => {
  mocks.alias = "hub-id";
  mocks.fetch.mockResolvedValue({ kind: "refused", status: 403 });
  const unmount = await open();
  expect(latest.state.problem).toEqual({ kind: "refused", status: 403 });
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
  unmount();
});

it("shows the saved list first and keeps it when the hub cannot be reached", async () => {
  mocks.alias = "hub-id";
  mocks.load.mockResolvedValue([machine]);
  mocks.fetch.mockResolvedValue({ kind: "unavailable", message: "Network request failed" });
  const unmount = await open();
  expect(latest.state.machines).toEqual([machine]);
  expect(latest.state.fromCache).toBe(true);
  expect(latest.state.problem).toEqual({ kind: "unavailable", message: "Network request failed" });
  expect(mocks.sync).not.toHaveBeenCalled();
  unmount();
});

it("refreshes on request without opening the picker", async () => {
  const unmount = await open();
  mocks.choose.mockClear();
  mocks.alias = null;
  mocks.fetch.mockResolvedValue({ kind: "no-certificate" });
  await act(async () => latest.refresh());
  expect(mocks.choose).not.toHaveBeenCalled();
  unmount();
});
