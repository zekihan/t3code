import { describe, expect, it } from "vite-plus/test";

import { clientCertificateWarning } from "./clientCertificateExpiry";

const now = Date.UTC(2026, 10, 17);
const day = 24 * 60 * 60 * 1000;

describe("clientCertificateWarning", () => {
  it("stays quiet without a certificate or with plenty of time left", () => {
    expect(clientCertificateWarning(null, now)).toBeNull();
    expect(clientCertificateWarning({ state: "valid", notAfter: now + 30 * day }, now)).toBeNull();
    expect(clientCertificateWarning({ state: "valid", notAfter: null }, now)).toBeNull();
  });

  it("warns below 30 days and counts whole days up", () => {
    expect(clientCertificateWarning({ state: "valid", notAfter: now + 29 * day + 1 }, now)).toBe(
      "The selected certificate expires in 30 days.",
    );
    expect(clientCertificateWarning({ state: "valid", notAfter: now + 5 * day }, now)).toBe(
      "The selected certificate expires in 5 days.",
    );
    expect(clientCertificateWarning({ state: "valid", notAfter: now + 1000 }, now)).toBe(
      "The selected certificate expires in 1 day.",
    );
  });

  it("reports expired, not-yet-valid and missing certificates", () => {
    expect(clientCertificateWarning({ state: "valid", notAfter: now - 1 }, now)).toBe(
      "The selected certificate has expired.",
    );
    expect(clientCertificateWarning({ state: "expired", notAfter: now - day }, now)).toBe(
      "The selected certificate has expired.",
    );
    expect(clientCertificateWarning({ state: "invalid", notAfter: now + day }, now)).toBe(
      "The selected certificate is not valid yet.",
    );
    expect(clientCertificateWarning({ state: "missing", notAfter: null }, now)).toBe(
      "The selected certificate is no longer available.",
    );
  });
});
