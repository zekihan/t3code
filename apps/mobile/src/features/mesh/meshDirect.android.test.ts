import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  hubContacted: vi.fn(),
  remove: vi.fn(),
  listener: undefined as undefined | ((event: { machine: string; origin: string }) => void),
  present: true,
}));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () =>
    mocks.present
      ? {
          getStatus: mocks.getStatus,
          hubContacted: mocks.hubContacted,
          addListener: (
            _name: string,
            listener: (event: { machine: string; origin: string }) => void,
          ) => {
            mocks.listener = listener;
            return { remove: mocks.remove };
          },
        }
      : null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.present = true;
  vi.resetModules();
});

it("asks the native module for the status of a URL and tells it about hub contacts", async () => {
  const api = await import("./meshDirect.android");
  mocks.getStatus.mockResolvedValue({ path: "direct" });
  expect(api.directAvailable).toBe(true);
  expect(await api.getDirectStatus("https://t3.z-arch.mesh.noqer.com")).toEqual({ path: "direct" });
  expect(mocks.getStatus).toHaveBeenCalledWith("https://t3.z-arch.mesh.noqer.com");
  api.notifyHubContacted();
  expect(mocks.hubContacted).toHaveBeenCalledOnce();
});

it("never lets a failed hub notification break a hub request", async () => {
  const api = await import("./meshDirect.android");
  mocks.hubContacted.mockImplementation(() => {
    throw new Error("native");
  });
  expect(() => api.notifyHubContacted()).not.toThrow();
});

it("subscribes to change events", async () => {
  const api = await import("./meshDirect.android");
  const listener = vi.fn();
  const subscription = api.onDirectChanged(listener);
  mocks.listener?.({ machine: "z-arch", origin: "https://t3.z-arch.mesh.noqer.com" });
  expect(listener).toHaveBeenCalledWith({
    machine: "z-arch",
    origin: "https://t3.z-arch.mesh.noqer.com",
  });
  subscription.remove();
  expect(mocks.remove).toHaveBeenCalledOnce();
});

it("is unavailable without the module", async () => {
  mocks.present = false;
  const api = await import("./meshDirect.android");
  expect(api.directAvailable).toBe(false);
  expect(await api.getDirectStatus("https://t3.z-arch.mesh.noqer.com")).toBeNull();
  expect(() => api.notifyHubContacted()).not.toThrow();
  expect(api.onDirectChanged(() => {}).remove).toBeTypeOf("function");
});

it("the other platforms report no direct connection", async () => {
  const api = await import("./meshDirect");
  expect(api.directAvailable).toBe(false);
  expect(await api.getDirectStatus("https://t3.z-arch.mesh.noqer.com")).toBeNull();
  expect(() => api.notifyHubContacted()).not.toThrow();
  expect(api.onDirectChanged(() => {}).remove).toBeTypeOf("function");
});
