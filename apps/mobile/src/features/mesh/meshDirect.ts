import type {
  DirectChangedEvent,
  DirectDecisionEntry,
  DirectDiagnostics,
  DirectStatus,
} from "./meshDirect.types";

// The direct connection at home is Android-only (meshDirect.android.ts).
export const directAvailable = false;
export const getDirectStatus = (_url: string): Promise<DirectStatus | null> =>
  Promise.resolve(null);
export const notifyHubContacted = (): void => {};
export const onDirectChanged = (
  _listener: (event: DirectChangedEvent) => void,
): { remove(): void } => ({ remove() {} });

export const isProviderFactoryInstalled = (): boolean | null => null;
export const getDirectDiagnostics = (_url: string): Promise<DirectDiagnostics | null> =>
  Promise.resolve(null);
export const getDirectDecisionLog = (): Promise<readonly DirectDecisionEntry[]> =>
  Promise.resolve([]);
export const testDirectPath = (_url: string): Promise<string | null> => Promise.resolve(null);
