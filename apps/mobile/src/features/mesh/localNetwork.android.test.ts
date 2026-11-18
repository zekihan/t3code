import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  request: vi.fn(),
  present: true,
}));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () =>
    mocks.present ? { getState: mocks.getState, request: mocks.request } : null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.present = true;
  vi.resetModules();
});

it("reads the state and asks the system through the native module", async () => {
  const api = await import("./localNetwork.android");
  mocks.getState.mockResolvedValue("denied");
  mocks.request.mockResolvedValue({ state: "granted", canAskAgain: false });
  expect(api.localNetworkAvailable).toBe(true);
  expect(await api.getLocalNetworkState()).toBe("denied");
  expect(await api.requestLocalNetwork()).toEqual({ state: "granted", canAskAgain: false });
});

it("reports the permission as not required without the module", async () => {
  mocks.present = false;
  const api = await import("./localNetwork.android");
  expect(api.localNetworkAvailable).toBe(false);
  expect(await api.getLocalNetworkState()).toBe("not-required");
  expect(await api.requestLocalNetwork()).toEqual({ state: "not-required", canAskAgain: false });
});

it("is never required on the other platforms", async () => {
  const api = await import("./localNetwork");
  expect(await api.getLocalNetworkState()).toBe("not-required");
  expect((await api.requestLocalNetwork()).state).toBe("not-required");
});
