import type { DirectChangedEvent, DirectStatus } from "./meshDirect.types";

// The direct connection at home is Android-only (meshDirect.android.ts).
export const directAvailable = false;
export const getDirectStatus = (_url: string): Promise<DirectStatus | null> =>
  Promise.resolve(null);
export const notifyHubContacted = (): void => {};
export const onDirectChanged = (
  _listener: (event: DirectChangedEvent) => void,
): { remove(): void } => ({ remove() {} });
