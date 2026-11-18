import type { LocalNetworkRequestResult, LocalNetworkState } from "./localNetwork.types";

// The local network permission is Android 17's (localNetwork.android.ts).
export const localNetworkAvailable = false;
export const getLocalNetworkState = (): Promise<LocalNetworkState> =>
  Promise.resolve("not-required");
export const requestLocalNetwork = (): Promise<LocalNetworkRequestResult> =>
  Promise.resolve({ state: "not-required", canAskAgain: false });
