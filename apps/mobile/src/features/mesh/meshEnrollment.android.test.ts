import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getEnrollment: vi.fn(),
  enroll: vi.fn(),
  renew: vi.fn(),
  remove: vi.fn(),
  setMeshOrigins: vi.fn(),
  remove_: vi.fn(),
  listener: undefined as undefined | (() => void),
  present: true,
}));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () =>
    mocks.present
      ? {
          getEnrollment: mocks.getEnrollment,
          enroll: mocks.enroll,
          renew: mocks.renew,
          remove: mocks.remove,
          setMeshOrigins: mocks.setMeshOrigins,
          addListener: (_name: string, listener: () => void) => {
            mocks.listener = listener;
            return { remove: mocks.remove_ };
          },
        }
      : null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.present = true;
  vi.resetModules();
});

it("passes the name, the token and the force flag to the native module", async () => {
  const api = await import("./meshEnrollment.android");
  mocks.enroll.mockResolvedValue({ identity: "device-z-phone-mesh" });
  mocks.renew.mockResolvedValue({ outcome: "renewed" });
  expect(api.enrollmentAvailable).toBe(true);
  await api.enrollDevice("device-z-phone-mesh", "tok");
  expect(mocks.enroll).toHaveBeenCalledWith("device-z-phone-mesh", "tok");
  await api.renewEnrollment(true);
  expect(mocks.renew).toHaveBeenCalledWith(true);
  await api.removeEnrollment();
  expect(mocks.remove).toHaveBeenCalledOnce();
  await api.setMeshOrigins(["https://t3.z-arch.mesh.noqer.com/"]);
  expect(mocks.setMeshOrigins).toHaveBeenCalledWith(["https://t3.z-arch.mesh.noqer.com/"]);
});

it("subscribes to change events", async () => {
  const api = await import("./meshEnrollment.android");
  const listener = vi.fn();
  const subscription = api.onEnrollmentChanged(listener);
  mocks.listener?.();
  expect(listener).toHaveBeenCalledOnce();
  subscription.remove();
  expect(mocks.remove_).toHaveBeenCalledOnce();
});

it("is unavailable without the module and refuses to enroll", async () => {
  mocks.present = false;
  const api = await import("./meshEnrollment.android");
  expect(api.enrollmentAvailable).toBe(false);
  expect(await api.getEnrollment()).toBeNull();
  await expect(api.enrollDevice("device-z-phone-mesh", "tok")).rejects.toThrow(
    "Android custom build",
  );
  await expect(api.setMeshOrigins([])).resolves.toBeUndefined();
  expect(api.onEnrollmentChanged(() => {}).remove).toBeTypeOf("function");
});

it("the other platforms report no enrollment and refuse to enroll", async () => {
  const api = await import("./meshEnrollment");
  expect(api.enrollmentAvailable).toBe(false);
  expect(await api.getEnrollment()).toBeNull();
  await expect(api.enrollDevice("a", "b")).rejects.toThrow("only supported on Android");
  await expect(api.setMeshOrigins(["https://t3.a.mesh.noqer.com/"])).resolves.toBeUndefined();
});
