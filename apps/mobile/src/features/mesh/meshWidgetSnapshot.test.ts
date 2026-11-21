import { expect, it } from "vite-plus/test";

import type { EnrollmentStatus } from "./meshEnrollment.types";
import { parseMeshFleet } from "./meshFleet";
import { buildMeshWidgetSnapshot, summarizeMeshWidgetPaths } from "./meshWidgetSnapshot";

const day = 86_400_000;
const now = Date.parse("2026-11-21T12:00:00Z");
const input = {
  fleet: null,
  path: "unknown",
  enrollment: null,
  checkedAt: null,
  now,
  locale: "en",
} as const;

const enrollment: EnrollmentStatus = {
  identity: "device-z-phone-mesh",
  issuedAt: now - day,
  notAfter: now + 30 * day,
  renewAt: now - 60 * day,
  state: "valid",
  renewalDue: true,
  protection: "tee",
  exportable: false,
  previous: null,
  caRevision: null,
  lastCheckAt: now,
  lastError: null,
};

it("counts only machines with both a live tunnel and reachable T3", () => {
  const machines = [
    { name: "healthy", online: true, services: { t3: { state: "reachable", since: null } } },
    { name: "offline", online: false, services: { t3: { state: "reachable", since: null } } },
    { name: "unhealthy", online: true, services: { t3: { state: "unreachable", since: null } } },
    { name: "unknown", online: true },
  ].map((machine) => ({ ...machine, viewerUrl: `https://t3.${machine.name}.mesh.noqer.com` }));
  const fleet = parseMeshFleet({ machines, caller: { path: "OCI" } });
  const snapshot = buildMeshWidgetSnapshot({
    ...input,
    fleet,
    checkedAt: now - day,
    path: summarizeMeshWidgetPaths([{ path: "direct" }, { path: "viewer" }]),
  });
  expect(snapshot).toMatchObject({
    fleet: "1/4 machines up",
    path: "Direct and via viewer",
    checkedAt: now - day,
    updated: expect.stringMatching(/^Updated .+/),
  });
  expect(
    buildMeshWidgetSnapshot({ ...input, fleet: { callerPath: null, machines: [] } }).fleet,
  ).toBe("0/0 machines up");
});

it("shows unknown fleet, path and timestamp before the first update", () => {
  expect(buildMeshWidgetSnapshot(input)).toEqual({
    fleet: "Fleet status unavailable",
    path: "Connection path unknown",
    certificate: "Not enrolled",
    certificateWarning: false,
    checkedAt: null,
    updated: "No fleet update yet",
  });
});

it("summarizes observed device routes independently of the hub request", () => {
  const path = (statuses: Parameters<typeof summarizeMeshWidgetPaths>[0]) =>
    buildMeshWidgetSnapshot({ ...input, path: summarizeMeshWidgetPaths(statuses) }).path;
  expect(path([{ path: "direct" }, null])).toBe("Direct at home");
  expect(path([{ path: "viewer" }])).toBe("Via viewer");
  expect(path([null])).toBe("Connection path unknown");
});

it("warns below 30 days, including a certificate with less than one day left", () => {
  const withExpiry = (notAfter: number) =>
    buildMeshWidgetSnapshot({ ...input, enrollment: { ...enrollment, notAfter } });
  expect(withExpiry(now + 30 * day)).toMatchObject({
    certificate: "Certificate expires in 30 days",
    certificateWarning: false,
  });
  expect(withExpiry(now + 30 * day - 1)).toMatchObject({
    certificate: "Certificate expires in 29 days",
    certificateWarning: true,
  });
  expect(withExpiry(now + 1)).toMatchObject({
    certificate: "Certificate expires in under an hour",
    certificateWarning: true,
  });
});

it("highlights re-enrollment when the certificate or key is unusable", () => {
  for (const status of [
    { ...enrollment, state: "reenroll" },
    { ...enrollment, state: "key-missing" },
    { ...enrollment, notAfter: now },
  ] as const) {
    expect(buildMeshWidgetSnapshot({ ...input, enrollment: status })).toMatchObject({
      certificate: "Re-enroll this device",
      certificateWarning: true,
    });
  }
});
