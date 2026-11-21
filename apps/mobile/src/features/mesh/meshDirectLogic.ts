import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import { LOCAL_NETWORK_DENIED } from "./localNetworkLogic";
import type { DirectFailure, DirectStatus, DirectViewerReason } from "./meshDirect.types";

const REASONS: Readonly<Record<DirectViewerReason, string>> = {
  "not-enrolled": msg("This device is not enrolled for direct connections."),
  "no-trust": msg("No trust information from the hub yet."),
  "trust-expired": msg("The hub was not reached for over a week, so direct connections are off."),
  "no-route": msg("The machine has no direct address: it is not at home."),
  "route-expired": msg("The machine's direct address is over a week old."),
  away: msg("The hub sees this phone away from home."),
  "local-network-denied": LOCAL_NETWORK_DENIED,
  "probe-failed": msg("The machine did not answer directly; trying again shortly."),
  pending: msg("Choosing a path."),
};

/** "Direct (LAN)" or "Viewer host": the path the environment's requests take. */
export function describePathLabel(status: DirectStatus, resolve: MessageResolver = m): string {
  return status.path === "direct"
    ? resolve(msg("Direct ({network})", { network: status.network ?? "LAN" }))
    : resolve(msg("Viewer host"));
}

/** Why the path is what it is, for the line under the label; null when it needs no explanation. */
export function describePathReason(
  status: DirectStatus,
  resolve: MessageResolver = m,
): string | null {
  if (status.path === "direct") {
    return status.identity === "previous"
      ? resolve(
          msg(
            "Using the previous device identity: this machine has not yet heard of the renewed one.",
          ),
        )
      : null;
  }
  if (status.reason === null || status.reason === "not-enrolled") return null;
  return resolve(REASONS[status.reason]);
}

/** A certificate or authorization failure on the direct path, worded for the person. */
export function describeDirectFailure(
  failure: DirectFailure,
  resolve: MessageResolver = m,
): string {
  switch (failure.kind) {
    case "certificate":
      return resolve(
        msg("The machine's certificate was refused: {detail}", { detail: failure.detail }),
      );
    case "authorization":
      return resolve(
        msg("The machine did not accept this device: {detail}", { detail: failure.detail }),
      );
    default:
      return failure.detail;
  }
}

/** The unknown-outcome notice: a request may have taken effect and was not repeated. */
export function describeUnknownOutcome(
  outcome: { readonly method: string },
  resolve: MessageResolver = m,
): string {
  return resolve(
    msg(
      "A {method} request failed on the direct connection after it was sent. It may have taken effect and was not repeated through the viewer host.",
      { method: outcome.method },
    ),
  );
}
