import type { ClientCertificateStatus } from "./clientCertificates.types";

export const CLIENT_CERTIFICATE_WARNING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns the warning to show for a chosen certificate, or null when it is fine. */
export function clientCertificateWarning(
  status: ClientCertificateStatus | null,
  now: number = Date.now(),
): string | null {
  if (status === null) return null;
  if (status.state === "missing") return "The selected certificate is no longer available.";
  if (status.state === "invalid") return "The selected certificate is not valid yet.";
  if (status.state === "expired") return "The selected certificate has expired.";
  if (status.notAfter === null) return null;
  const remaining = status.notAfter - now;
  if (remaining >= CLIENT_CERTIFICATE_WARNING_DAYS * DAY_MS) return null;
  if (remaining <= 0) return "The selected certificate has expired.";
  const days = Math.ceil(remaining / DAY_MS);
  return days === 1
    ? "The selected certificate expires in 1 day."
    : `The selected certificate expires in ${days} days.`;
}

/** Set when the saved certificate cannot be presented, so a certificate must be selected again. */
export function clientCertificateSelectionMessage(
  status: ClientCertificateStatus | null,
): string | null {
  if (status === null || status.state === "valid") return null;
  if (status.state === "expired") return "The saved certificate has expired. Select a renewed one.";
  if (status.state === "invalid")
    return "The saved certificate is not valid yet. Select another one.";
  return "The saved certificate is no longer available. Select it again.";
}
