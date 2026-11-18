import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import type { EnrollmentStatus, RenewResult } from "./meshEnrollment.types";
import { useMeshEnrollment, type MeshEnrollmentApi } from "./useMeshEnrollment";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-18T12:00:00Z");
const status = (overrides: Partial<EnrollmentStatus> = {}): EnrollmentStatus => ({
  identity: "device-z-phone-mesh",
  issuedAt: NOW,
  notAfter: NOW + 365 * DAY,
  renewAt: NOW + 275 * DAY,
  state: "valid",
  renewalDue: false,
  protection: "tee",
  exportable: false,
  previous: null,
  caRevision: "rev-1",
  lastCheckAt: 0,
  lastError: null,
  ...overrides,
});

const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

const mocks = {
  get: vi.fn<() => Promise<EnrollmentStatus | null>>(),
  enroll: vi.fn<(identity: string, token: string) => Promise<EnrollmentStatus>>(),
  renew: vi.fn<(force: boolean) => Promise<RenewResult>>(),
  remove: vi.fn<() => Promise<void>>(),
  listeners: [] as Array<() => void>,
  unsubscribed: vi.fn(),
};
const api: MeshEnrollmentApi = {
  available: true,
  getEnrollment: () => mocks.get(),
  enrollDevice: (identity, token) => mocks.enroll(identity, token),
  renewEnrollment: (force) => mocks.renew(force),
  removeEnrollment: () => mocks.remove(),
  onChanged: (listener) => {
    mocks.listeners.push(listener);
    return { remove: mocks.unsubscribed };
  },
};

let latest: ReturnType<typeof useMeshEnrollment>;
function Probe() {
  const value = useMeshEnrollment(api);
  useLayoutEffect(() => {
    latest = value;
  });
  return null;
}

async function open() {
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  return () => act(() => root.unmount());
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listeners.length = 0;
  mocks.get.mockResolvedValue(null);
});

it("reads the native state when the screen opens", async () => {
  mocks.get.mockResolvedValue(status());
  const unmount = await open();
  expect(latest.state.loaded).toBe(true);
  expect(latest.state.status?.identity).toBe("device-z-phone-mesh");
  expect(latest.state.busy).toBeNull();
  unmount();
  expect(mocks.unsubscribed).toHaveBeenCalledOnce();
});

it("shows an unenrolled device as no status", async () => {
  const unmount = await open();
  expect(latest.state.loaded).toBe(true);
  expect(latest.state.status).toBeNull();
  unmount();
});

it("enrolls with the name and token, and shows the new status", async () => {
  mocks.enroll.mockResolvedValue(status({ identity: "device-z-tablet-mesh" }));
  const unmount = await open();
  let enrolled = false;
  await act(async () => {
    enrolled = await latest.enroll("device-z-tablet-mesh", "tok");
  });
  expect(enrolled).toBe(true);
  expect(mocks.enroll).toHaveBeenCalledWith("device-z-tablet-mesh", "tok");
  expect(latest.state.status?.identity).toBe("device-z-tablet-mesh");
  expect(latest.state.failure).toBeNull();
  expect(latest.state.busy).toBeNull();
  unmount();
});

it("reports progress while the hub is contacted", async () => {
  let finish: (value: EnrollmentStatus) => void = () => {};
  mocks.enroll.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const unmount = await open();
  let pending: Promise<boolean> = Promise.resolve(false);
  await act(async () => {
    pending = latest.enroll("device-z-phone-mesh", "tok");
  });
  expect(latest.state.busy).toBe("enroll");
  await act(async () => {
    finish(status());
    await pending;
  });
  expect(latest.state.busy).toBeNull();
  unmount();
});

it("maps an expired or used token to its own message and keeps the old identity", async () => {
  mocks.get.mockResolvedValue(status());
  mocks.enroll.mockRejectedValue(coded("TOKEN_INVALID", "The token is expired, already used."));
  const unmount = await open();
  let enrolled = true;
  await act(async () => {
    enrolled = await latest.enroll("device-z-phone-mesh", "old");
  });
  expect(enrolled).toBe(false);
  expect(latest.state.failure).toEqual({
    code: "TOKEN_INVALID",
    title: "Token expired or already used",
    detail: "The token is expired, already used.",
  });
  expect(latest.state.status?.identity).toBe("device-z-phone-mesh");
  unmount();
});

it("tells network, TLS and wrong-kind failures apart", async () => {
  const unmount = await open();
  for (const [code, title] of [
    ["NETWORK", "Network problem"],
    ["TLS", "Could not verify the hub"],
    ["TOKEN_IDENTITY", "Token is for another identity"],
    ["IDENTITY_NOT_ALLOWED", "Identity not allowed"],
  ] as const) {
    mocks.enroll.mockRejectedValueOnce(coded(code, "native"));
    await act(async () => {
      await latest.enroll("device-z-phone-mesh", "tok");
    });
    expect(latest.state.failure?.title).toBe(title);
  }
  unmount();
});

it("clears the last failure when the next attempt starts", async () => {
  mocks.enroll.mockRejectedValueOnce(coded("NETWORK", "down"));
  const unmount = await open();
  await act(async () => {
    await latest.enroll("device-z-phone-mesh", "tok");
  });
  expect(latest.state.failure).not.toBeNull();
  mocks.enroll.mockResolvedValue(status());
  await act(async () => {
    await latest.enroll("device-z-phone-mesh", "tok");
  });
  expect(latest.state.failure).toBeNull();
  unmount();
});

it("renews now with force and re-reads the status", async () => {
  mocks.get.mockResolvedValue(status());
  mocks.renew.mockResolvedValue({ outcome: "renewed" });
  const unmount = await open();
  mocks.get.mockResolvedValue(status({ previous: { notAfter: 1, keepUntil: 2 } }));
  await act(async () => latest.renew());
  expect(mocks.renew).toHaveBeenCalledWith(true);
  expect(latest.state.notice).toContain("Renewed");
  expect(latest.state.status?.previous).not.toBeNull();
  unmount();
});

it("shows a failed renewal as a failure with the hub's code", async () => {
  mocks.get.mockResolvedValue(status());
  mocks.renew.mockResolvedValue({
    outcome: "failed",
    code: "REENROLL_REQUIRED",
    message: "The hub no longer accepts this device's certificate.",
  });
  const unmount = await open();
  await act(async () => latest.renew());
  expect(latest.state.failure?.title).toBe("Re-enroll this device");
  expect(latest.state.notice).toBeNull();
  unmount();
});

it("removes the enrollment", async () => {
  mocks.get.mockResolvedValue(status());
  mocks.remove.mockResolvedValue(undefined);
  const unmount = await open();
  await act(async () => latest.remove());
  expect(mocks.remove).toHaveBeenCalledOnce();
  expect(latest.state.status).toBeNull();
  expect(latest.state.notice).toBe("Enrollment removed.");
  unmount();
});

it("re-reads when the module reports a change, for example a renewal at app start", async () => {
  const unmount = await open();
  expect(latest.state.status).toBeNull();
  mocks.get.mockResolvedValue(status({ state: "reenroll" }));
  await act(async () => mocks.listeners[0]!());
  expect(latest.state.status?.state).toBe("reenroll");
  unmount();
});

it("shows a read failure instead of staying on the spinner", async () => {
  mocks.get.mockRejectedValue(coded("KEYSTORE", "keystore down"));
  const unmount = await open();
  expect(latest.state.loaded).toBe(true);
  expect(latest.state.failure?.title).toBe("Keystore problem");
  unmount();
});
