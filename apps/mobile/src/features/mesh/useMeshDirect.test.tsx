import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import type { DirectChangedEvent, DirectStatus } from "./meshDirect.types";
import { useMeshDirect, type MeshDirectApi } from "./useMeshDirect";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = "https://t3.z-arch.mesh.noqer.com";
const status = (overrides: Partial<DirectStatus> = {}): DirectStatus => ({
  path: "viewer",
  network: null,
  reason: "away",
  identity: null,
  failure: null,
  unreachable: null,
  unknownOutcome: null,
  probing: false,
  trustFetchedAt: null,
  routeSavedAt: null,
  ...overrides,
});

const mocks = {
  get: vi.fn<(url: string) => Promise<DirectStatus | null>>(),
  listeners: [] as Array<(event: DirectChangedEvent) => void>,
  unsubscribed: vi.fn(),
};
const api: MeshDirectApi = {
  getStatus: (url) => mocks.get(url),
  onChanged: (listener) => {
    mocks.listeners.push(listener);
    return { remove: mocks.unsubscribed };
  },
};

let latest: DirectStatus | null;
function Probe(props: { readonly origin: string }) {
  const value = useMeshDirect(props.origin, api);
  useLayoutEffect(() => {
    latest = value;
  });
  return null;
}

async function open(origin = ORIGIN) {
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe origin={origin} />));
  return { unmount: () => act(() => root.unmount()) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listeners.length = 0;
  latest = null;
});

it("reads the status of the origin once it opens", async () => {
  mocks.get.mockResolvedValue(status({ path: "direct", network: "LAN", reason: null }));
  const view = await open();
  expect(mocks.get).toHaveBeenCalledWith(ORIGIN);
  expect(latest?.path).toBe("direct");
  await view.unmount();
});

it("reads again when the native layer reports a change for this origin only", async () => {
  mocks.get.mockResolvedValue(status());
  const view = await open();
  mocks.get.mockResolvedValue(status({ path: "direct", network: "LAN", reason: null }));
  await act(async () => {
    mocks.listeners[0]?.({ machine: "z-mac", origin: "https://t3.z-mac.mesh.noqer.com" });
  });
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(latest?.path).toBe("viewer");
  await act(async () => {
    mocks.listeners[0]?.({ machine: "z-arch", origin: ORIGIN });
  });
  expect(mocks.get).toHaveBeenCalledTimes(2);
  expect(latest?.path).toBe("direct");
  await view.unmount();
});

it("stays null where there is no native module, and for a failed read", async () => {
  mocks.get.mockResolvedValue(null);
  const none = await open();
  expect(latest).toBeNull();
  await none.unmount();

  mocks.get.mockRejectedValue(new Error("native error"));
  const broken = await open();
  expect(latest).toBeNull();
  await broken.unmount();
});

it("stops listening when it unmounts and ignores a late answer", async () => {
  let resolve: (value: DirectStatus | null) => void = () => {};
  mocks.get.mockReturnValue(new Promise((done) => (resolve = done)));
  const view = await open();
  await view.unmount();
  expect(mocks.unsubscribed).toHaveBeenCalledOnce();
  await act(async () => resolve(status()));
  expect(latest).toBeNull();
});
