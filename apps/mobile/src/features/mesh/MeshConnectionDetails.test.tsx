import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ useMeshFleet: vi.fn(), focused: true }));
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
vi.mock("./useMeshFleet", () => ({ useMeshFleet: mocks.useMeshFleet }));

import {
  MeshConnectionDetails,
  MeshConnectionDetailsView,
  machineAtOrigin,
} from "./MeshConnectionDetails";
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
