import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("expo-network", () => ({ addNetworkStateListener: vi.fn() }));
vi.mock("react-native", () => ({ AppState: { addEventListener: vi.fn() } }));

import {
  FLEET_REFRESH_DEBOUNCE_MS,
  watchFleetRefreshTriggers,
  type FleetRefreshSources,
} from "./meshNetwork";

function sources() {
  let network: ((connected: boolean) => void) | null = null;
  let active: (() => void) | null = null;
  const stopNetwork = vi.fn();
  const stopActive = vi.fn();
  const value: FleetRefreshSources = {
    onNetworkChange: (listener) => {
      network = listener;
      return stopNetwork;
    },
    onAppActive: (listener) => {
      active = listener;
      return stopActive;
    },
  };
  return {
    value,
    network: (connected: boolean) => network?.(connected),
    active: () => active?.(),
    stopNetwork,
    stopActive,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("refreshes once after a burst of network changes", () => {
  const fake = sources();
  const trigger = vi.fn();
  watchFleetRefreshTriggers(trigger, fake.value);
  fake.network(true);
  vi.advanceTimersByTime(FLEET_REFRESH_DEBOUNCE_MS - 100);
  fake.network(true);
  vi.advanceTimersByTime(FLEET_REFRESH_DEBOUNCE_MS - 100);
  expect(trigger).not.toHaveBeenCalled();
  vi.advanceTimersByTime(100);
  expect(trigger).toHaveBeenCalledOnce();
});

it("refreshes when the app returns to the front", () => {
  const fake = sources();
  const trigger = vi.fn();
  watchFleetRefreshTriggers(trigger, fake.value);
  fake.active();
  vi.advanceTimersByTime(FLEET_REFRESH_DEBOUNCE_MS);
  expect(trigger).toHaveBeenCalledOnce();
});

it("does not refresh when the network is lost", () => {
  const fake = sources();
  const trigger = vi.fn();
  watchFleetRefreshTriggers(trigger, fake.value);
  fake.network(false);
  vi.advanceTimersByTime(FLEET_REFRESH_DEBOUNCE_MS * 2);
  expect(trigger).not.toHaveBeenCalled();
});

it("stops listening and cancels a pending refresh when unsubscribed", () => {
  const fake = sources();
  const trigger = vi.fn();
  const stop = watchFleetRefreshTriggers(trigger, fake.value);
  fake.network(true);
  stop();
  vi.advanceTimersByTime(FLEET_REFRESH_DEBOUNCE_MS * 2);
  expect(trigger).not.toHaveBeenCalled();
  expect(fake.stopNetwork).toHaveBeenCalledOnce();
  expect(fake.stopActive).toHaveBeenCalledOnce();
});
