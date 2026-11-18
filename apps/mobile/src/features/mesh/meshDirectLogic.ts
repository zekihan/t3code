import { LOCAL_NETWORK_DENIED } from "./localNetworkLogic";
import type { DirectFailure, DirectStatus, DirectViewerReason } from "./meshDirect.types";

const REASONS: Readonly<Record<DirectViewerReason, string>> = {
  "not-enrolled": "This device is not enrolled for direct connections.",
  "no-trust": "No trust information from the hub yet.",
  "trust-expired": "The hub was not reached for over a week, so direct connections are off.",
  "no-route": "The machine has no direct address: it is not at home.",
  "route-expired": "The machine's direct address is over a week old.",
  away: "The hub sees this phone away from home.",
  "local-network-denied": LOCAL_NETWORK_DENIED,
  "probe-failed": "The machine did not answer directly; trying again shortly.",
  pending: "Choosing a path.",
};

/** "Direct (LAN)" or "Viewer host": the path the environment's requests take. */
export function describePathLabel(status: DirectStatus): string {
  return status.path === "direct" ? `Direct (${status.network ?? "LAN"})` : "Viewer host";
}

/** Why the path is what it is, for the line under the label; null when it needs no explanation. */
export function describePathReason(status: DirectStatus): string | null {
  if (status.path === "direct") {
    return status.identity === "previous"
      ? "Using the previous device identity: this machine has not yet heard of the renewed one."
      : null;
  }
  if (status.reason === null || status.reason === "not-enrolled") return null;
  return REASONS[status.reason];
}

/** A certificate or authorization failure on the direct path, worded for the person. */
export function describeDirectFailure(failure: DirectFailure): string {
  switch (failure.kind) {
    case "certificate":
      return `The machine's certificate was refused: ${failure.detail}`;
    case "authorization":
      return `The machine did not accept this device: ${failure.detail}`;
    default:
      return failure.detail;
  }
}

/** The unknown-outcome notice: a request may have taken effect and was not repeated. */
export function describeUnknownOutcome(outcome: { readonly method: string }): string {
  return `A ${outcome.method} request failed on the direct connection after it was sent. It may have taken effect and was not repeated through the viewer host.`;
}
