import { expect, it } from "vite-plus/test";

import {
  describeHubRequest,
  formatAlert,
  formatCertificateExpiry,
  formatRtt,
  formatTunnelUptime,
  parseMeshFleet,
} from "./meshFleet";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const arch = {
  name: "z-arch",
  online: true,
  lastSeen: "2026-11-18T11:59:00Z",
  viewerUrl: "https://t3.z-arch.mesh.noqer.com",
  agentVersion: "0.1.12",
  certNotAfter: "2027-02-01T00:00:00Z",
  tunnel: { path: "LAN", connectedSince: "2026-11-18T08:48:00Z" },
  alerts: ["cert-expiry", "disconnected"],
};

it("parses a full fleet entry and the caller's path", () => {
  const fleet = parseMeshFleet({ caller: { path: "OCI" }, machines: [arch] });
  expect(fleet).toEqual({
    callerPath: "OCI",
    machines: [
      {
        name: "z-arch",
        online: true,
        lastSeen: Date.parse("2026-11-18T11:59:00Z"),
        viewerOrigin: "https://t3.z-arch.mesh.noqer.com",
        agentVersion: "0.1.12",
        certNotAfter: Date.parse("2027-02-01T00:00:00Z"),
        tunnelPath: "LAN",
        connectedSince: Date.parse("2026-11-18T08:48:00Z"),
        alerts: ["cert-expiry", "disconnected"],
        services: {},
      },
    ],
  });
});

it("reads the hub's nulls and absences as unknown", () => {
  const fleet = parseMeshFleet({
    caller: { path: null },
    machines: [
      {
        name: "z-mac",
        online: false,
        lastSeen: null,
        viewerUrl: "https://t3.z-mac.mesh.noqer.com/",
        agentVersion: null,
        certNotAfter: null,
        tunnel: { path: null, connectedSince: null },
        alerts: [],
      },
      { name: "bare", online: true, viewerUrl: "https://t3.bare.mesh.noqer.com" },
    ],
  });
  expect(fleet?.callerPath).toBeNull();
  expect(fleet?.machines[0]).toEqual({
    name: "z-mac",
    online: false,
    lastSeen: null,
    viewerOrigin: "https://t3.z-mac.mesh.noqer.com",
    agentVersion: null,
    certNotAfter: null,
    tunnelPath: null,
    connectedSince: null,
    alerts: [],
    services: {},
  });
  expect(fleet?.machines[1]).toMatchObject({
    tunnelPath: null,
    connectedSince: null,
    agentVersion: null,
    alerts: [],
    services: {},
  });
  expect(parseMeshFleet({ machines: [] })).toEqual({ callerPath: null, machines: [] });
});

it("treats a path other than LAN or OCI, and unreadable times, as unknown", () => {
  const fleet = parseMeshFleet({
    caller: { path: "WAN" },
    machines: [
      { ...arch, certNotAfter: "soon", lastSeen: 5, tunnel: { path: "lan", connectedSince: "x" } },
    ],
  });
  expect(fleet?.callerPath).toBeNull();
  expect(fleet?.machines[0]).toMatchObject({
    certNotAfter: null,
    lastSeen: null,
    tunnelPath: null,
    connectedSince: null,
  });
});

it("drops entries with an invalid viewer URL, malformed entries and repeated names", () => {
  const fleet = parseMeshFleet({
    caller: { path: "LAN" },
    machines: [
      arch,
      { ...arch, name: "evil", viewerUrl: "https://t3.evil.example" },
      { ...arch, name: "z-mac", viewerUrl: "https://t3.z-arch.mesh.noqer.com" },
      { ...arch, viewerUrl: "https://t3.z-arch.mesh.noqer.com", agentVersion: "other" },
      null,
      "z-arch",
      { online: true },
    ],
  });
  expect(fleet?.machines.map((machine) => [machine.name, machine.agentVersion])).toEqual([
    ["z-arch", "0.1.12"],
  ]);
});

it("keeps only distinct, short string alerts", () => {
  const fleet = parseMeshFleet({
    machines: [{ ...arch, alerts: ["cert-expiry", "cert-expiry", 7, "", "x".repeat(100), "new"] }],
  });
  expect(fleet?.machines[0]?.alerts).toEqual(["cert-expiry", "new"]);
  expect(
    parseMeshFleet({ machines: [{ ...arch, alerts: "cert-expiry" }] })?.machines[0]?.alerts,
  ).toEqual([]);
});

it.each([null, "x", 3, [], {}, { machines: "z-arch" }])("rejects %j as not a fleet", (payload) => {
  expect(parseMeshFleet(payload)).toBeNull();
});

it("formats tunnel uptime", () => {
  expect(formatTunnelUptime(null, NOW)).toBeNull();
  expect(formatTunnelUptime(NOW - 20_000, NOW)).toBe("Up less than a minute");
  expect(formatTunnelUptime(NOW + 5_000, NOW)).toBe("Up less than a minute");
  expect(formatTunnelUptime(NOW - 7 * MINUTE, NOW)).toBe("Up 7m");
  expect(formatTunnelUptime(NOW - (3 * HOUR + 12 * MINUTE + 5_000), NOW)).toBe("Up 3h 12m");
  expect(formatTunnelUptime(NOW - (2 * DAY + 4 * HOUR + 59 * MINUTE), NOW)).toBe("Up 2d 4h");
});

it("warns about a certificate under 30 days from expiry, not at 30", () => {
  expect(formatCertificateExpiry(NOW + 29 * DAY + HOUR, NOW)).toEqual({
    label: "Certificate expires in 29 days",
    warn: true,
  });
  expect(formatCertificateExpiry(NOW + 30 * DAY, NOW)).toEqual({
    label: "Certificate expires in 30 days",
    warn: false,
  });
  expect(formatCertificateExpiry(NOW + 90 * DAY, NOW).warn).toBe(false);
  expect(formatCertificateExpiry(NOW + 1 * DAY, NOW).label).toBe("Certificate expires in 1 day");
  expect(formatCertificateExpiry(NOW + 5 * HOUR, NOW)).toEqual({
    label: "Certificate expires in 5 hours",
    warn: true,
  });
  expect(formatCertificateExpiry(NOW + 10 * MINUTE, NOW).label).toBe(
    "Certificate expires in under an hour",
  );
});

it("reports an expired or unknown certificate expiry", () => {
  expect(formatCertificateExpiry(NOW - 3 * DAY, NOW)).toEqual({
    label: "Certificate expired 3 days ago",
    warn: true,
  });
  expect(formatCertificateExpiry(NOW - 2 * HOUR, NOW).label).toBe(
    "Certificate expired 2 hours ago",
  );
  expect(formatCertificateExpiry(NOW - 10 * MINUTE, NOW).label).toBe(
    "Certificate expired just now",
  );
  expect(formatCertificateExpiry(null, NOW)).toEqual({
    label: "Certificate expiry unknown",
    warn: false,
  });
});

it("labels known alerts and shows unknown ones as sent", () => {
  expect(formatAlert("cert-expiry")).toBe("Certificate expiring");
  expect(formatAlert("disconnected")).toBe("Disconnected");
  expect(formatAlert("disk-full")).toBe("disk-full");
});

it("labels the hub request as the phone's own, separate from the viewer connection", () => {
  expect(formatRtt(41.6)).toBe("42 ms");
  expect(describeHubRequest({ path: "LAN", rttMs: 42 })).toEqual({
    path: "Hub request path: LAN",
    rtt: "Round-trip time: 42 ms",
    note: "This phone's last request to the hub; the viewer connection can use a different path.",
  });
  expect(describeHubRequest({ path: null, rttMs: 7 }).path).toBe("Hub request path: unknown");
});

it("parses service health and ignores malformed services", () => {
  const fleet = parseMeshFleet({
    machines: [
      {
        ...arch,
        services: {
          t3: { state: "unreachable", checkedAt: "2026-11-18T11:59:00Z" },
          web: { state: "reachable", checkedAt: null },
          old: { state: "unknown", checkedAt: null },
          invalid: { state: "broken", checkedAt: null },
          badTime: { state: "reachable", checkedAt: "bad" },
          missingTime: { state: "reachable" },
          badEntry: null,
        },
      },
    ],
  });
  expect(fleet?.machines[0]?.services).toEqual({
    t3: { state: "unreachable", checkedAt: NOW - MINUTE },
    web: { state: "reachable", checkedAt: null },
    old: { state: "unknown", checkedAt: null },
  });
  expect(parseMeshFleet({ machines: [{ ...arch, services: [] }] })?.machines[0]?.services).toEqual(
    {},
  );
  expect(parseMeshFleet({ machines: [arch] })?.machines[0]?.services).toEqual({});
});
