import type { EnrollmentFailure, EnrollmentStatus } from "./meshEnrollment.types";

const DAY = 24 * 60 * 60 * 1000;

/** The same rule the app and the hub apply: `device-<name>-mesh`. */
export const DEVICE_IDENTITY = /^device-[a-z0-9]+(-[a-z0-9]+)*-mesh$/;
// The longest name the hub issues a certificate for.
const MAX_IDENTITY_LENGTH = 40;

/** The two devices this fork enrolls. Typing another valid name works too. */
export const IDENTITY_SUGGESTIONS = ["device-z-phone-mesh", "device-z-tablet-mesh"] as const;

const ENROLLED_ALIAS_PREFIX = "enrolled:";

/** The alias the transport reports for a mesh origin that uses the enrolled identity. */
export const isEnrolledAlias = (alias: string | null | undefined): boolean =>
  typeof alias === "string" && alias.startsWith(ENROLLED_ALIAS_PREFIX);

/** Null when `name` is a valid device identity, else what is wrong with it. */
export function identityProblem(name: string): string | null {
  if (name.length === 0) return "Enter this device's name.";
  if (name.length > MAX_IDENTITY_LENGTH) return "That name is too long.";
  if (DEVICE_IDENTITY.test(name)) return null;
  return "Use the form device-z-phone-mesh: lowercase letters, digits and hyphens, starting with device- and ending with -mesh.";
}

const TITLES: Readonly<Record<string, string>> = {
  INVALID_IDENTITY: "Not a device name",
  TOKEN_REQUIRED: "Token needed",
  NETWORK: "Network problem",
  TLS: "Could not verify the hub",
  NO_ENROLLMENT_OPEN: "No enrollment is open",
  TOKEN_INVALID: "Token expired or already used",
  TOKEN_IDENTITY: "Token is for another identity",
  IDENTITY_NOT_ALLOWED: "Identity not allowed",
  CSR_REJECTED: "Request refused",
  RATE_LIMITED: "Too many attempts",
  ISSUANCE_FAILED: "The hub could not issue a certificate",
  HUB_ERROR: "The hub refused",
  BAD_REPLY: "Unexpected answer from the hub",
  KEYSTORE: "Keystore problem",
  REENROLL_REQUIRED: "Re-enroll this device",
  NOT_ENROLLED: "Not enrolled",
  BUSY: "Another operation is running",
};

/** An error from the native module as a title and the native message. */
export function describeEnrollmentFailure(error: unknown): EnrollmentFailure {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "UNKNOWN";
  const detail =
    error instanceof Error && error.message ? error.message : "Something went wrong. Try again.";
  return { code, title: TITLES[code] ?? "Enrollment failed", detail };
}

const formatDay = (epochMs: number) =>
  new Date(epochMs).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" });

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

const PROTECTION_LABELS = {
  strongbox: "Held in the secure chip (StrongBox). It cannot be exported.",
  tee: "Held in the Android Keystore's secure hardware. It cannot be exported.",
  software: "Held in the Android Keystore, in software on this device. It cannot be exported.",
  unknown: "Held in the Android Keystore. It cannot be exported.",
} as const;

interface EnrollmentSummary {
  readonly headline: string;
  readonly expires: string;
  readonly renewal: string;
  readonly key: string;
  readonly previous: string | null;
  readonly lastRenewalProblem: string | null;
  /** Set when the device needs a new token; the notice explains why. */
  readonly needsReenroll: string | null;
}

/** The status line the Mesh screen shows: identity, expiry and the next renewal. */
export function summarizeEnrollment(status: EnrollmentStatus, now: number): EnrollmentSummary {
  const daysLeft = Math.ceil((status.notAfter - now) / DAY);
  const expires =
    status.notAfter <= now
      ? `Expired on ${formatDay(status.notAfter)}`
      : `Expires ${formatDay(status.notAfter)} (${plural(daysLeft, "day")} left)`;
  const renewal =
    status.state !== "valid"
      ? "Not renewing: this device must be enrolled again."
      : status.renewalDue
        ? "Renewal is due. It runs when the app next opens, or tap Renew now."
        : `Renews automatically from ${formatDay(status.renewAt)}.`;
  const reenroll: Record<string, string> = {
    reenroll:
      "The hub no longer accepts this device's certificate, for example because a renewal went through but its answer was lost. Re-enroll this device with a new token.",
    expired: "The certificate has expired. Re-enroll this device with a new token.",
    "key-missing":
      "The key is no longer in the Android Keystore (a screen lock or biometric change can remove it). Re-enroll this device with a new token.",
  };
  return {
    headline: `Enrolled as ${status.identity}`,
    expires,
    renewal,
    key: status.exportable
      ? "Warning: this key could be read out of the Keystore. Re-enroll this device."
      : PROTECTION_LABELS[status.protection],
    previous: status.previous
      ? `The previous key is kept until ${formatDay(status.previous.keepUntil)}.`
      : null,
    lastRenewalProblem:
      status.lastError === null
        ? null
        : status.lastError === "offline"
          ? "The last renewal check could not reach the hub. It will try again."
          : `The last renewal check failed (${status.lastError}).`,
    needsReenroll: reenroll[status.state] ?? null,
  };
}

/** What a finished renewal means to the person who asked for it. */
export function renewNotice(result: {
  readonly outcome: string;
  readonly message?: string;
}): string {
  switch (result.outcome) {
    case "renewed":
      return "Renewed. The previous key stays for a week.";
    case "not-due":
      return "Nothing to renew yet.";
    case "throttled":
      return "A renewal check already ran recently.";
    case "not-enrolled":
      return "This device is not enrolled.";
    default:
      return result.message ?? "Renewal failed.";
  }
}
