import * as Network from "expo-network";
import { AppState } from "react-native";

/** What can change the hub-request path: the phone's network, or the app coming back to the front. */
export interface FleetRefreshSources {
  /** Calls `listener(connected)` when the network changes; returns its unsubscribe. */
  readonly onNetworkChange: (listener: (connected: boolean) => void) => () => void;
  readonly onAppActive: (listener: () => void) => () => void;
}

export const nativeFleetRefreshSources: FleetRefreshSources = {
  onNetworkChange: (listener) => {
    const subscription = Network.addNetworkStateListener((state) =>
      listener(state.isConnected !== false),
    );
    return () => subscription.remove();
  },
  onAppActive: (listener) => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") listener();
    });
    return () => subscription.remove();
  },
};

export const FLEET_REFRESH_DEBOUNCE_MS = 800;

/**
 * Calls `onTrigger` after the network changes to a connected state or the app returns to the
 * front, so the hub-request path and round-trip time follow the phone's current network. A burst
 * of events (Wi-Fi to cellular reports several) causes one call, and losing the network none:
 * nothing could be measured then. Returns the unsubscribe.
 */
export function watchFleetRefreshTriggers(
  onTrigger: () => void,
  sources: FleetRefreshSources = nativeFleetRefreshSources,
  debounceMs: number = FLEET_REFRESH_DEBOUNCE_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onTrigger();
    }, debounceMs);
  };
  const stopNetwork = sources.onNetworkChange((connected) => {
    if (connected) schedule();
  });
  const stopApp = sources.onAppActive(schedule);
  return () => {
    stopNetwork();
    stopApp();
    if (timer !== null) clearTimeout(timer);
  };
}
