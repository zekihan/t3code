import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../i18n/messages";
import type { ClientCertificateStatus } from "./clientCertificates.types";

export const CLIENT_CERTIFICATE_WARNING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns the warning to show for a chosen certificate, or null when it is fine. */
export function clientCertificateWarning(
  status: ClientCertificateStatus | null,
  now: number = Date.now(),
  resolve: MessageResolver = m,
): string | null {
  if (status === null) return null;
  if (status.state === "missing")
    return resolve(msg("The selected certificate is no longer available."));
  if (status.state === "invalid") return resolve(msg("The selected certificate is not valid yet."));
  if (status.state === "expired") return resolve(msg("The selected certificate has expired."));
  if (status.notAfter === null) return null;
  const remaining = status.notAfter - now;
  if (remaining >= CLIENT_CERTIFICATE_WARNING_DAYS * DAY_MS) return null;
  if (remaining <= 0) return resolve(msg("The selected certificate has expired."));
  const days = Math.ceil(remaining / DAY_MS);
  return resolve(
    msg(
      "{count, plural, one {The selected certificate expires in {count} day.} other {The selected certificate expires in {count} days.}}",
      { count: days },
    ),
  );
}

/** Set when the saved certificate cannot be presented, so a certificate must be selected again. */
export function clientCertificateSelectionMessage(
  status: ClientCertificateStatus | null,
  resolve: MessageResolver = m,
): string | null {
  if (status === null || status.state === "valid") return null;
  if (status.state === "expired")
    return resolve(msg("The saved certificate has expired. Select a renewed one."));
  if (status.state === "invalid")
    return resolve(msg("The saved certificate is not valid yet. Select another one."));
  return resolve(msg("The saved certificate is no longer available. Select it again."));
}
