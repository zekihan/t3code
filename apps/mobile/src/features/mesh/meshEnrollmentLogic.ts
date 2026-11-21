import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
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
export function identityProblem(name: string, resolve: MessageResolver = m): string | null {
  if (name.length === 0) return resolve(msg("Enter this device's name."));
  if (name.length > MAX_IDENTITY_LENGTH) return resolve(msg("That name is too long."));
  if (DEVICE_IDENTITY.test(name)) return null;
  return resolve(
    msg(
      "Use the form {example}: lowercase letters, digits and hyphens, starting with {prefix} and ending with {suffix}.",
      { example: "device-z-phone-mesh", prefix: "device-", suffix: "-mesh" },
    ),
  );
}

const TITLES: Readonly<Record<string, string>> = {
  INVALID_IDENTITY: msg("Not a device name"),
  TOKEN_REQUIRED: msg("Token needed"),
  NETWORK: msg("Network problem"),
  TLS: msg("Could not verify the hub"),
  NO_ENROLLMENT_OPEN: msg("No enrollment is open"),
  TOKEN_INVALID: msg("Token expired or already used"),
  TOKEN_IDENTITY: msg("Token is for another identity"),
  IDENTITY_NOT_ALLOWED: msg("Identity not allowed"),
  CSR_REJECTED: msg("Request refused"),
  RATE_LIMITED: msg("Too many attempts"),
  ISSUANCE_FAILED: msg("The hub could not issue a certificate"),
  HUB_ERROR: msg("The hub refused"),
  BAD_REPLY: msg("Unexpected answer from the hub"),
  KEYSTORE: msg("Keystore problem"),
  REENROLL_REQUIRED: msg("Re-enroll this device"),
  NOT_ENROLLED: msg("Not enrolled"),
  BUSY: msg("Another operation is running"),
};

/** An error from the native module as a title and the native message. */
export function describeEnrollmentFailure(
  error: unknown,
  resolve: MessageResolver = m,
): EnrollmentFailure {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "UNKNOWN";
  const detail =
    error instanceof Error && error.message
      ? error.message
      : resolve(msg("Something went wrong. Try again."));
  return { code, title: resolve(TITLES[code] ?? msg("Enrollment failed")), detail };
}

const formatDay = (epochMs: number) =>
  new Date(epochMs).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" });

const PROTECTION_LABELS = {
  strongbox: msg("Held in the secure chip (StrongBox). It cannot be exported."),
  tee: msg("Held in the Android Keystore's secure hardware. It cannot be exported."),
  software: msg("Held in the Android Keystore, in software on this device. It cannot be exported."),
  unknown: msg("Held in the Android Keystore. It cannot be exported."),
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
export function summarizeEnrollment(
  status: EnrollmentStatus,
  now: number,
  resolve: MessageResolver = m,
): EnrollmentSummary {
  const daysLeft = Math.ceil((status.notAfter - now) / DAY);
  const expires =
    status.notAfter <= now
      ? resolve(msg("Expired on {date}", { date: formatDay(status.notAfter) }))
      : resolve(
          msg("Expires {date} ({count, plural, one {{count} day} other {{count} days}} left)", {
            date: formatDay(status.notAfter),
            count: daysLeft,
          }),
        );
  const renewal =
    status.state !== "valid"
      ? resolve(msg("Not renewing: this device must be enrolled again."))
      : status.renewalDue
        ? resolve(msg("Renewal is due. It runs when the app next opens, or tap Renew now."))
        : resolve(msg("Renews automatically from {date}.", { date: formatDay(status.renewAt) }));
  const reenroll: Record<string, string> = {
    reenroll: msg(
      "The hub no longer accepts this device's certificate, for example because a renewal went through but its answer was lost. Re-enroll this device with a new token.",
    ),
    expired: msg("The certificate has expired. Re-enroll this device with a new token."),
    "key-missing": msg(
      "The key is no longer in the Android Keystore (a screen lock or biometric change can remove it). Re-enroll this device with a new token.",
    ),
  };
  const needsReenroll = reenroll[status.state];
  return {
    headline: resolve(msg("Enrolled as {identity}", { identity: status.identity })),
    expires,
    renewal,
    key: status.exportable
      ? resolve(msg("Warning: this key could be read out of the Keystore. Re-enroll this device."))
      : resolve(PROTECTION_LABELS[status.protection]),
    previous: status.previous
      ? resolve(
          msg("The previous key is kept until {date}.", {
            date: formatDay(status.previous.keepUntil),
          }),
        )
      : null,
    lastRenewalProblem:
      status.lastError === null
        ? null
        : status.lastError === "offline"
          ? resolve(msg("The last renewal check could not reach the hub. It will try again."))
          : resolve(msg("The last renewal check failed ({error}).", { error: status.lastError })),
    needsReenroll: needsReenroll === undefined ? null : resolve(needsReenroll),
  };
}

/** What a finished renewal means to the person who asked for it. */
export function renewNotice(
  result: {
    readonly outcome: string;
    readonly message?: string;
  },
  resolve: MessageResolver = m,
): string {
  switch (result.outcome) {
    case "renewed":
      return resolve(msg("Renewed. The previous key stays for a week."));
    case "not-due":
      return resolve(msg("Nothing to renew yet."));
    case "throttled":
      return resolve(msg("A renewal check already ran recently."));
    case "not-enrolled":
      return resolve(msg("This device is not enrolled."));
    default:
      return result.message ?? resolve(msg("Renewal failed."));
  }
}
