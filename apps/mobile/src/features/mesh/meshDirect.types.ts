export type DirectFailureKind =
  | "certificate"
  | "authorization"
  | "unreachable"
  | "timeout"
  | "unexpected";

/** Why an attempt at the direct path failed, and when (epoch milliseconds). */
export interface DirectFailure {
  readonly kind: DirectFailureKind;
  readonly detail: string;
  readonly at: number;
}

/**
 * Why an environment is on the viewer host: the device is not enrolled, there is no trust or
 * route, one of them is more than a week old, the hub says the phone is away, a direct attempt
 * failed (kept for 60 s), or the decision has not been made yet.
 */
export type DirectViewerReason =
  | "not-enrolled"
  | "no-trust"
  | "trust-expired"
  | "no-route"
  | "route-expired"
  | "away"
  | "probe-failed"
  | "pending";

/** The path an environment's requests take, as the native layer decided it. */
export interface DirectStatus {
  readonly path: "direct" | "viewer";
  /** "LAN" while the path is direct. */
  readonly network: "LAN" | null;
  readonly reason: DirectViewerReason | null;
  /** Which enrolled identity the direct path presents; "previous" during a renewal's overlap. */
  readonly identity: "current" | "previous" | null;
  /** The latest certificate or authorization failure; kept until a probe passes. */
  readonly failure: DirectFailure | null;
  /** The latest failure that only means the machine could not be reached. */
  readonly unreachable: DirectFailure | null;
  /** A request that may have reached the machine failed on the direct path and was not repeated. */
  readonly unknownOutcome: { readonly at: number; readonly method: string } | null;
  readonly probing: boolean;
  readonly trustFetchedAt: number | null;
  readonly routeSavedAt: number | null;
}

export interface DirectChangedEvent {
  readonly machine: string;
  readonly origin: string;
}

/** The Android native module. */
export interface MeshDirectNative {
  getStatus(url: string): Promise<DirectStatus | null>;
  /** The app just contacted the hub: the native side refreshes trust and routes. */
  hubContacted(): void;
  addListener(
    name: "directChanged",
    listener: (event: DirectChangedEvent) => void,
  ): { remove(): void };
}
