import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  useMeshFleet: vi.fn(),
  useMeshDirect: vi.fn(),
  openSettings: vi.fn(),
  focused: true,
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => mocks.focused }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: ({ title, children }: { title: string; children?: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./useLocalNetworkAccess", () => ({
  useLocalNetworkAccess: () => ({
    state: "denied",
    ask: vi.fn(),
    openSettings: mocks.openSettings,
  }),
}));
vi.mock("./useMeshFleet", () => ({ useMeshFleet: mocks.useMeshFleet }));
vi.mock("./useMeshDirect", () => ({ useMeshDirect: mocks.useMeshDirect }));

import {
  MeshConnectionDetails,
  MeshConnectionDetailsView,
  machineAtOrigin,
} from "./MeshConnectionDetails";
import type { DirectStatus } from "./meshDirect.types";
import type { MeshFleetMachine } from "./meshFleet";
import type { MeshFleetState } from "./useMeshFleet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-18T12:00:00Z");
const ORIGIN = "https://t3.z-arch.mesh.noqer.com";
const machine = (overrides: Partial<MeshFleetMachine> = {}): MeshFleetMachine => ({
  name: "z-arch",
  online: true,
  lastSeen: NOW,
  viewerOrigin: ORIGIN,
  agentVersion: "0.1.12",
  certNotAfter: null,
  tunnelPath: "OCI",
  connectedSince: NOW - 2 * 3_600_000,
  alerts: [],
  ...overrides,
});
const state = (overrides: Partial<MeshFleetState> = {}): MeshFleetState => ({
  fleet: { callerPath: "LAN", machines: [machine()] },
  request: { path: "LAN", rttMs: 42 },
  problem: null,
  loading: false,
  now: NOW,
  ...overrides,
});

const direct = (overrides: Partial<DirectStatus> = {}): DirectStatus => ({
  path: "viewer",
  network: null,
  reason: "away",
  identity: null,
  failure: null,
  unreachable: null,
  unknownOutcome: null,
  probing: false,
  trustFetchedAt: NOW,
  routeSavedAt: NOW,
  ...overrides,
});

function render(node: ReactNode) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, unmount: () => act(() => root.unmount()) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.focused = true;
  mocks.useMeshFleet.mockReturnValue({ state: state() });
  mocks.useMeshDirect.mockReturnValue(null);
});

it("shows the machine's tunnel and the phone's hub request as two separate paths", () => {
  const view = render(<MeshConnectionDetailsView state={state()} origin={ORIGIN} />);
  const text = view.container.textContent ?? "";
  expect(view.container.querySelector("section")?.getAttribute("aria-label")).toBe(
    "Mesh connection",
  );
  expect(text).toContain("Tunnel up");
  expect(text).toContain("Tunnel path: OCI · Up 2h 0m");
  expect(text).toContain("Hub request path: LAN");
  expect(text).toContain("Round-trip time: 42 ms");
  expect(text).toContain(
    "This phone's last request to the hub; the viewer connection can use a different path.",
  );
  view.unmount();
});

it("shows a down tunnel without an uptime", () => {
  const view = render(
    <MeshConnectionDetailsView
      state={state({
        fleet: { callerPath: "OCI", machines: [machine({ online: false, tunnelPath: null })] },
        request: { path: "OCI", rttMs: 120 },
      })}
      origin={ORIGIN}
    />,
  );
  const text = view.container.textContent ?? "";
  expect(text).toContain("Tunnel down");
  expect(text).toContain("Tunnel path: unknown");
  expect(text).not.toContain("Up ");
  expect(text).toContain("Hub request path: OCI");
  expect(text).toContain("Round-trip time: 120 ms");
  view.unmount();
});

it("renders nothing for a machine the hub does not list", () => {
  expect(machineAtOrigin(state(), "https://t3.other.mesh.noqer.com")).toBeNull();
  const view = render(
    <MeshConnectionDetailsView state={state()} origin="https://t3.other.mesh.noqer.com" />,
  );
  expect(view.container.innerHTML).toBe("");
  view.unmount();
});

it("explains a refused or unreachable hub only when it has no answer yet", () => {
  const refused = render(
    <MeshConnectionDetailsView
      state={state({ fleet: null, request: null, problem: { kind: "refused", status: 403 } })}
      origin={ORIGIN}
    />,
  );
  expect(refused.container.textContent).toContain("Connection details unavailable");
  refused.unmount();

  const noCertificate = render(
    <MeshConnectionDetailsView
      state={state({
        fleet: null,
        request: null,
        problem: { kind: "no-certificate", message: null },
      })}
      origin={ORIGIN}
    />,
  );
  expect(noCertificate.container.innerHTML).toBe("");
  noCertificate.unmount();

  const loading = render(
    <MeshConnectionDetailsView
      state={state({ fleet: null, request: null, loading: true })}
      origin={ORIGIN}
    />,
  );
  expect(loading.container.innerHTML).toBe("");
  loading.unmount();

  const stale = render(
    <MeshConnectionDetailsView
      state={state({ problem: { kind: "unavailable", message: "no route" } })}
      origin={ORIGIN}
    />,
  );
  expect(stale.container.textContent).toContain("Tunnel up");
  expect(stale.container.textContent).toContain("Could not refresh. no route");
  stale.unmount();
});

it("asks the hub only for an environment on a mesh viewer host", () => {
  const other = render(<MeshConnectionDetails displayUrl="https://example.com" />);
  expect(other.container.innerHTML).toBe("");
  expect(mocks.useMeshFleet).not.toHaveBeenCalled();
  other.unmount();

  const mesh = render(<MeshConnectionDetails displayUrl={`${ORIGIN}/`} />);
  expect(mocks.useMeshFleet).toHaveBeenCalledWith({ focused: true });
  expect(mesh.container.textContent).toContain("Hub request path: LAN");
  mesh.unmount();
});

it("tells the fleet hook when the screen is not focused", () => {
  mocks.focused = false;
  const view = render(<MeshConnectionDetails displayUrl={ORIGIN} />);
  expect(mocks.useMeshFleet).toHaveBeenCalledWith({ focused: false });
  view.unmount();
});

it("shows the active path as direct over the LAN", () => {
  const view = render(
    <MeshConnectionDetailsView
      state={state()}
      origin={ORIGIN}
      direct={direct({ path: "direct", network: "LAN", reason: null })}
    />,
  );
  const text = view.container.textContent ?? "";
  expect(text).toContain("Connection path: Direct (LAN)");
  expect(text).not.toContain("Viewer host");
  expect(text).toContain("Tunnel up");
  view.unmount();
});

it("shows the viewer host and why, when the hub sees the phone away", () => {
  const view = render(
    <MeshConnectionDetailsView state={state()} origin={ORIGIN} direct={direct()} />,
  );
  const text = view.container.textContent ?? "";
  expect(text).toContain("Connection path: Viewer host");
  expect(text).toContain("The hub sees this phone away from home.");
  view.unmount();
});

it("says nothing about why when the device is not enrolled", () => {
  const view = render(
    <MeshConnectionDetailsView
      state={state()}
      origin={ORIGIN}
      direct={direct({ reason: "not-enrolled" })}
    />,
  );
  const text = view.container.textContent ?? "";
  expect(text).toContain("Connection path: Viewer host");
  expect(text).not.toContain("enrolled");
  view.unmount();
});

it("shows a certificate failure even though the viewer host carries the traffic", () => {
  const view = render(
    <MeshConnectionDetailsView
      state={state()}
      origin={ORIGIN}
      direct={direct({
        reason: "probe-failed",
        failure: {
          kind: "certificate",
          detail: "The agent's certificate was revoked.",
          at: NOW,
        },
      })}
    />,
  );
  const text = view.container.textContent ?? "";
  expect(text).toContain("Connection path: Viewer host");
  expect(text).toContain(
    "The machine's certificate was refused: The agent's certificate was revoked.",
  );
  view.unmount();
});

it("shows an authorization failure and a plain unreachable machine differently", () => {
  const refused = render(
    <MeshConnectionDetailsView
      state={state()}
      origin={ORIGIN}
      direct={direct({
        reason: "probe-failed",
        failure: {
          kind: "authorization",
          detail: "The machine did not accept this device's identity.",
          at: NOW,
        },
      })}
    />,
  );
  expect(refused.container.textContent).toContain(
    "The machine did not accept this device: The machine did not accept this device's identity.",
  );
  refused.unmount();

  const silent = render(
    <MeshConnectionDetailsView
      state={state()}
      origin={ORIGIN}
      direct={direct({
        reason: "probe-failed",
        unreachable: {
          kind: "timeout",
          detail: "TCP and TLS did not finish within 2000 ms.",
          at: NOW,
        },
      })}
    />,
  );
  const text = silent.container.textContent ?? "";
  expect(text).toContain("The machine did not answer directly; trying again shortly.");
  expect(text).toContain("TCP and TLS did not finish within 2000 ms.");
  expect(text).not.toContain("refused");
  silent.unmount();
});

it("tells the person a request was not repeated when its outcome is unknown", () => {
  const view = render(
    <MeshConnectionDetailsView
      state={state()}
      origin={ORIGIN}
      direct={direct({ unknownOutcome: { at: NOW, method: "POST" } })}
    />,
  );
  expect(view.container.textContent).toContain(
    "A POST request failed on the direct connection after it was sent. It may have taken effect and was not repeated through the viewer host.",
  );
  view.unmount();
});

it("notes when the direct path uses the previous device identity", () => {
  const view = render(
    <MeshConnectionDetailsView
      state={state()}
      origin={ORIGIN}
      direct={direct({ path: "direct", network: "LAN", reason: null, identity: "previous" })}
    />,
  );
  expect(view.container.textContent).toContain(
    "Using the previous device identity: this machine has not yet heard of the renewed one.",
  );
  view.unmount();
});

it("shows the path without the hub, from a cold start", () => {
  const view = render(
    <MeshConnectionDetailsView
      state={state({ fleet: null, request: null, loading: true })}
      origin={ORIGIN}
      direct={direct({ path: "direct", network: "LAN", reason: null })}
    />,
  );
  const text = view.container.textContent ?? "";
  expect(text).toContain("Connection path: Direct (LAN)");
  expect(text).not.toContain("Tunnel");
  expect(text).not.toContain("Connection details unavailable");
  view.unmount();
});

it("shows the path and the hub problem together when the hub cannot be reached", () => {
  const view = render(
    <MeshConnectionDetailsView
      state={state({
        fleet: null,
        request: null,
        problem: { kind: "unavailable", message: "no route" },
      })}
      origin={ORIGIN}
      direct={direct({ path: "direct", network: "LAN", reason: null })}
    />,
  );
  const text = view.container.textContent ?? "";
  expect(text).toContain("Connection path: Direct (LAN)");
  expect(text).toContain("Connection details unavailable. no route");
  view.unmount();
});

it("reads the path of the environment's own origin", () => {
  mocks.useMeshDirect.mockReturnValue(direct({ path: "direct", network: "LAN", reason: null }));
  const view = render(<MeshConnectionDetails displayUrl={`${ORIGIN}/`} />);
  expect(mocks.useMeshDirect).toHaveBeenCalledWith(ORIGIN);
  expect(view.container.textContent).toContain("Connection path: Direct (LAN)");
  view.unmount();
});

it("says local network access was denied and offers Settings", () => {
  const view = render(
    <MeshConnectionDetailsView
      state={state()}
      origin={ORIGIN}
      direct={direct({ reason: "local-network-denied" })}
      onOpenSettings={mocks.openSettings}
    />,
  );
  const text = view.container.textContent ?? "";
  expect(text).toContain("Connection path: Viewer host");
  expect(text).toContain("Local network access denied. Allow it in Settings.");
  const button = view.container.querySelector("button");
  expect(button?.textContent).toBe("Settings");
  act(() => button?.click());
  expect(mocks.openSettings).toHaveBeenCalledOnce();
  view.unmount();
});

it("offers Settings only for a denied permission", () => {
  const view = render(
    <MeshConnectionDetailsView
      state={state()}
      origin={ORIGIN}
      direct={direct({ reason: "away" })}
      onOpenSettings={mocks.openSettings}
    />,
  );
  expect(view.container.querySelector("button")).toBeNull();
  view.unmount();
});

it("wires the Settings button of a mesh environment to the app's settings", () => {
  mocks.useMeshDirect.mockReturnValue(direct({ reason: "local-network-denied" }));
  const view = render(<MeshConnectionDetails displayUrl={ORIGIN} />);
  act(() => view.container.querySelector("button")?.click());
  expect(mocks.openSettings).toHaveBeenCalledOnce();
  view.unmount();
});
