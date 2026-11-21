import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  isEnabled: vi.fn<() => boolean>(),
  setEnabled: vi.fn<(enabled: boolean) => Promise<boolean>>(),
  request: vi.fn<(permission: string, rationale: unknown) => Promise<string>>(),
  version: 33,
}));

vi.mock("expo", () => ({ requireOptionalNativeModule: () => mocks }));
vi.mock("react-native", () => ({
  Platform: {
    get Version() {
      return mocks.version;
    },
  },
  PermissionsAndroid: {
    PERMISSIONS: { POST_NOTIFICATIONS: "android.permission.POST_NOTIFICATIONS" },
    RESULTS: { GRANTED: "granted" },
    request: mocks.request,
  },
}));

import {
  isFleetNotificationsEnabled,
  setFleetNotificationsEnabled,
} from "./meshFleetNotifications.android";

const rationale = {
  title: "Fleet notifications",
  message: "Get updates about outages.",
  buttonPositive: "Continue",
};

function setup(version: number, grant: string) {
  mocks.version = version;
  mocks.isEnabled.mockReset().mockReturnValue(true);
  mocks.setEnabled.mockReset().mockImplementation(async (enabled) => enabled);
  mocks.request.mockReset().mockResolvedValue(grant);
}

it("uses the native default and asks for permission before turning on Android 13", async () => {
  setup(33, "granted");
  expect(isFleetNotificationsEnabled()).toBe(true);
  await expect(setFleetNotificationsEnabled(true, rationale)).resolves.toBe(true);
  expect(mocks.request).toHaveBeenCalledWith("android.permission.POST_NOTIFICATIONS", rationale);
  expect(mocks.request).toHaveBeenCalledBefore(mocks.setEnabled);
  expect(mocks.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
});

it("leaves the switch off when Android denies permission", async () => {
  setup(33, "denied");
  await expect(setFleetNotificationsEnabled(true, rationale)).resolves.toBe(false);
  expect(mocks.setEnabled).not.toHaveBeenCalled();
});

it("turns off without asking Android for permission", async () => {
  setup(33, "denied");
  await expect(setFleetNotificationsEnabled(false, rationale)).resolves.toBe(false);
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.setEnabled).toHaveBeenCalledExactlyOnceWith(false);
});

it("turns on without a runtime notification prompt before Android 13", async () => {
  setup(32, "denied");
  await expect(setFleetNotificationsEnabled(true, rationale)).resolves.toBe(true);
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
});
