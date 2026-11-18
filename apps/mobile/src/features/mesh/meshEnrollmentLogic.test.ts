import { expect, it } from "vite-plus/test";

import type { EnrollmentStatus } from "./meshEnrollment.types";
import {
  DEVICE_IDENTITY,
  IDENTITY_SUGGESTIONS,
  describeEnrollmentFailure,
  identityProblem,
  isEnrolledAlias,
  renewNotice,
  summarizeEnrollment,
} from "./meshEnrollmentLogic";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-18T12:00:00Z");

const status = (overrides: Partial<EnrollmentStatus> = {}): EnrollmentStatus => ({
  identity: "device-z-phone-mesh",
  issuedAt: NOW - DAY,
  notAfter: NOW + 365 * DAY,
  renewAt: NOW + 275 * DAY,
  state: "valid",
  renewalDue: false,
  protection: "tee",
  exportable: false,
  previous: null,
  caRevision: "rev-1",
  lastCheckAt: NOW,
  lastError: null,
  ...overrides,
});

it("accepts the two device names and other well-formed ones", () => {
  for (const name of [...IDENTITY_SUGGESTIONS, "device-a1-mesh", "device-a-b-c-mesh"]) {
    expect(identityProblem(name)).toBeNull();
    expect(DEVICE_IDENTITY.test(name)).toBe(true);
  }
});

it("refuses agent names, bare names and malformed ones before anything is sent", () => {
  for (const name of [
    "",
    "agent-z-mac",
    "z-phone",
    "device-mesh",
    "device--mesh",
    "device-z-phone",
    "Device-z-mesh",
    "device-z_phone-mesh",
    "device-z phone-mesh",
    `device-${"a".repeat(30)}-mesh`,
  ]) {
    expect(identityProblem(name), name).not.toBeNull();
  }
  expect(identityProblem("agent-z-mac")).toContain("device-z-phone-mesh");
});

it("recognises the enrolled alias the transport reports", () => {
  expect(isEnrolledAlias("enrolled:device-z-phone-mesh")).toBe(true);
  expect(isEnrolledAlias("my-keychain-alias")).toBe(false);
  expect(isEnrolledAlias(null)).toBe(false);
  expect(isEnrolledAlias(undefined)).toBe(false);
});

it("maps each native error code to a clear title and keeps the native message", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["TOKEN_INVALID", "Token expired or already used"],
    ["NO_ENROLLMENT_OPEN", "No enrollment is open"],
    ["TOKEN_IDENTITY", "Token is for another identity"],
    ["IDENTITY_NOT_ALLOWED", "Identity not allowed"],
    ["NETWORK", "Network problem"],
    ["TLS", "Could not verify the hub"],
    ["RATE_LIMITED", "Too many attempts"],
    ["KEYSTORE", "Keystore problem"],
    ["REENROLL_REQUIRED", "Re-enroll this device"],
    ["BAD_REPLY", "Unexpected answer from the hub"],
  ];
  for (const [code, title] of cases) {
    const failure = describeEnrollmentFailure(Object.assign(new Error("native words"), { code }));
    expect(failure).toEqual({ code, title, detail: "native words" });
  }
});

it("falls back for errors that carry no known code", () => {
  expect(describeEnrollmentFailure(new Error("boom"))).toEqual({
    code: "UNKNOWN",
    title: "Enrollment failed",
    detail: "boom",
  });
  expect(describeEnrollmentFailure("odd").detail).toBe("Something went wrong. Try again.");
  expect(describeEnrollmentFailure(Object.assign(new Error("x"), { code: "NEW_ONE" })).title).toBe(
    "Enrollment failed",
  );
});

it("summarizes a healthy identity: name, expiry, next renewal and the key", () => {
  const summary = summarizeEnrollment(status(), NOW);
  expect(summary.headline).toBe("Enrolled as device-z-phone-mesh");
  expect(summary.expires).toBe("Expires Nov 18, 2027 (365 days left)");
  expect(summary.renewal).toBe("Renews automatically from Aug 20, 2027.");
  expect(summary.key).toContain("cannot be exported");
  expect(summary.previous).toBeNull();
  expect(summary.lastRenewalProblem).toBeNull();
  expect(summary.needsReenroll).toBeNull();
});

it("says a renewal is due, and when the previous key goes", () => {
  const summary = summarizeEnrollment(
    status({
      renewalDue: true,
      notAfter: NOW + 60 * DAY,
      previous: { notAfter: NOW + 10 * DAY, keepUntil: NOW + 3 * DAY },
      lastError: "offline",
    }),
    NOW,
  );
  expect(summary.renewal).toContain("Renewal is due");
  expect(summary.previous).toBe("The previous key is kept until Nov 21, 2026.");
  expect(summary.lastRenewalProblem).toContain("could not reach the hub");
});

it("asks for re-enrollment when the hub refused the leaf, the certificate expired or the key is gone", () => {
  const refused = summarizeEnrollment(status({ state: "reenroll" }), NOW);
  expect(refused.needsReenroll).toContain("no longer accepts this device's certificate");
  expect(refused.renewal).toContain("enrolled again");
  const expired = summarizeEnrollment(status({ state: "expired", notAfter: NOW - 2 * DAY }), NOW);
  expect(expired.expires).toBe("Expired on Nov 16, 2026");
  expect(expired.needsReenroll).toContain("has expired");
  const missing = summarizeEnrollment(status({ state: "key-missing" }), NOW);
  expect(missing.needsReenroll).toContain("no longer in the Android Keystore");
});

it("labels where the key lives", () => {
  expect(summarizeEnrollment(status({ protection: "strongbox" }), NOW).key).toContain("StrongBox");
  expect(summarizeEnrollment(status({ protection: "software" }), NOW).key).toContain("in software");
  expect(summarizeEnrollment(status({ protection: "unknown" }), NOW).key).toContain(
    "cannot be exported",
  );
});

it("warns instead of promising when the key could be exported", () => {
  const summary = summarizeEnrollment(status({ exportable: true }), NOW);
  expect(summary.key).toContain("could be read out of the Keystore");
  expect(summary.key).not.toContain("cannot be exported");
});

it("words each renewal result", () => {
  expect(renewNotice({ outcome: "renewed" })).toContain("previous key stays for a week");
  expect(renewNotice({ outcome: "not-due" })).toBe("Nothing to renew yet.");
  expect(renewNotice({ outcome: "throttled" })).toContain("already ran");
  expect(renewNotice({ outcome: "failed", message: "no route" })).toBe("no route");
  expect(renewNotice({ outcome: "failed" })).toBe("Renewal failed.");
});
