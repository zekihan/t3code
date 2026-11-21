import { requireOptionalNativeModule } from "expo";

import type { DirectChangedEvent, DirectStatus, MeshDirectNative } from "./meshDirect.types";

// The module lives in modules/t3-client-certificates, next to the transport that routes requests.
const native = requireOptionalNativeModule<MeshDirectNative>("T3MeshDirect");

export const directAvailable = native !== null;

/** The path an environment on a mesh viewer host takes; null for any other URL or without the module. */
export const getDirectStatus = (url: string): Promise<DirectStatus | null> =>
  native ? native.getStatus(url) : Promise.resolve(null);

/** Tells the native side the hub was just contacted, so trust and routes refresh with it. */
export const notifyHubContacted = (): void => {
  try {
    native?.hubContacted();
  } catch {
    // The direct path refreshes on its own too: at start, on network changes and in the foreground.
  }
};

export const onDirectChanged = (
  listener: (event: DirectChangedEvent) => void,
): { remove(): void } => native?.addListener("directChanged", listener) ?? { remove() {} };

export const isProviderFactoryInstalled = () => native?.isProviderFactoryInstalled?.() ?? null;
export const getDirectDiagnostics = async (url: string) =>
  (await native?.getDiagnostics?.(url)) ?? null;
export const getDirectDecisionLog = async () => (await native?.getDecisionLog?.()) ?? [];
export const testDirectPath = async (url: string) => (await native?.testDirectPath?.(url)) ?? null;
