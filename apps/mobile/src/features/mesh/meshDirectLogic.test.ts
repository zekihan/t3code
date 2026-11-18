import { expect, it } from "vite-plus/test";

import type { DirectStatus, DirectViewerReason } from "./meshDirect.types";
import {
  describeDirectFailure,
  describePathLabel,
  describePathReason,
  describeUnknownOutcome,
} from "./meshDirectLogic";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const status = (overrides: Partial<DirectStatus> = {}): DirectStatus => ({
  path: "viewer",
  network: null,
  reason: "away",
  identity: null,
  failure: null,
  unreachable: null,
  unknownOutcome: null,
  probing: false,
  trustFetchedAt: NOW,
  routeSavedAt: NOW,
  ...overrides,
});

it("labels the direct path with its network and the other one as the viewer host", () => {
  expect(describePathLabel(status({ path: "direct", network: "LAN", reason: null }))).toBe(
    "Direct (LAN)",
  );
  expect(describePathLabel(status())).toBe("Viewer host");
});

it("explains every reason the viewer host is used, except a device that is not enrolled", () => {
  const reasons: DirectViewerReason[] = [
    "no-trust",
    "trust-expired",
    "no-route",
    "route-expired",
    "away",
    "probe-failed",
    "pending",
  ];
  const lines = reasons.map((reason) => describePathReason(status({ reason })));
  expect(lines.every((line) => typeof line === "string" && line.length > 0)).toBe(true);
  expect(new Set(lines).size).toBe(reasons.length);
  expect(describePathReason(status({ reason: "not-enrolled" }))).toBeNull();
  expect(describePathReason(status({ reason: null }))).toBeNull();
});

it("needs no explanation for the direct path unless it uses the previous identity", () => {
  expect(describePathReason(status({ path: "direct", network: "LAN", reason: null }))).toBeNull();
  expect(
    describePathReason(
      status({ path: "direct", network: "LAN", reason: null, identity: "previous" }),
    ),
  ).toContain("previous device identity");
});

it("words certificate and authorization failures differently", () => {
  expect(describeDirectFailure({ kind: "certificate", detail: "revoked", at: NOW })).toBe(
    "The machine's certificate was refused: revoked",
  );
  expect(describeDirectFailure({ kind: "authorization", detail: "no", at: NOW })).toBe(
    "The machine did not accept this device: no",
  );
  expect(describeDirectFailure({ kind: "timeout", detail: "slow", at: NOW })).toBe("slow");
});

it("names the method of a request whose outcome is unknown", () => {
  expect(describeUnknownOutcome({ method: "PUT" })).toContain("A PUT request");
  expect(describeUnknownOutcome({ method: "PUT" })).toContain("was not repeated");
});
