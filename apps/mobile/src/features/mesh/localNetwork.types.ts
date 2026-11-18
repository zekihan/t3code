/**
 * Android 17's local network permission, as far as this app is concerned: "not-required" below
 * Android 17 and for an app that targets less than 37 (the platform grants it implicitly).
 */
export type LocalNetworkState = "not-required" | "granted" | "denied";

export interface LocalNetworkRequestResult {
  readonly state: LocalNetworkState;
  /** False once Android will no longer show the prompt: only Settings can grant it then. */
  readonly canAskAgain: boolean;
}

/** The Android native module. */
export interface LocalNetworkNative {
  getState(): Promise<LocalNetworkState>;
  /** Shows the system prompt when the permission is missing; resolves with the outcome. */
  request(): Promise<LocalNetworkRequestResult>;
}
