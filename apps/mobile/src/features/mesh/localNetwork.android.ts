import { requireOptionalNativeModule } from "expo";

import type {
  LocalNetworkNative,
  LocalNetworkRequestResult,
  LocalNetworkState,
} from "./localNetwork.types";

// The module lives in modules/t3-client-certificates, next to the transport that the permission gates.
const native = requireOptionalNativeModule<LocalNetworkNative>("T3MeshLocalNetwork");

export const localNetworkAvailable = native !== null;

export const getLocalNetworkState = (): Promise<LocalNetworkState> =>
  native ? native.getState() : Promise.resolve("not-required");

export const requestLocalNetwork = (): Promise<LocalNetworkRequestResult> =>
  native ? native.request() : Promise.resolve({ state: "not-required", canAskAgain: false });
