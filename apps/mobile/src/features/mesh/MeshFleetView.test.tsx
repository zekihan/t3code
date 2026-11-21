import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <i>spinner</i>,
}));
vi.mock("../../components/ui/Chip", () => ({
  Chip: ({ label }: { label: string }) => <mark>{label}</mark>,
}));
vi.mock("../../components/ui/Notice", () => ({
  Notice: ({ message }: { message: string }) => <p role="alert">{message}</p>,
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: {
    title: string;
    detail: string;
    actionLabel?: string;
    onAction?: () => void;
  }) => (
    <section>
      <h1>{props.title}</h1>
      <p>{props.detail}</p>
      {props.actionLabel ? <button onClick={props.onAction}>{props.actionLabel}</button> : null}
    </section>
  ),
}));
vi.mock("../connection/ConnectionStatusDot", () => ({
  ConnectionStatusDot: ({ state }: { state: string }) => <b data-dot={state} />,
}));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));

import { MeshFleetView, meshFleetViewKind, type MeshFleetViewProps } from "./MeshFleetView";
import type { MeshFleetMachine } from "./meshFleet";
import type { MeshFleetState } from "./useMeshFleet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-18T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const machine = (name: string, overrides: Partial<MeshFleetMachine> = {}): MeshFleetMachine => ({
  name,
  online: true,
  lastSeen: NOW,
  viewerOrigin: `https://t3.${name}.mesh.noqer.com`,
  agentVersion: "0.1.12",
  certNotAfter: NOW + 90 * DAY,
  tunnelPath: "LAN",
  connectedSince: NOW - (3 * HOUR + 12 * 60_000),
  alerts: [],
  services: {},
  ...overrides,
});
const state = (overrides: Partial<MeshFleetState>): MeshFleetState => ({
  fleet: null,
  request: null,
  problem: null,
  loading: false,
  now: NOW,
  ...overrides,
});

function render(overrides: Partial<MeshFleetViewProps> & { state: MeshFleetState }) {
  const props: MeshFleetViewProps = {
    certificateWarning: null,
    onChooseCertificate: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<MeshFleetView {...props} />));
  return { container, props, unmount: () => act(() => root.unmount()) };
}

const listed = (machines: MeshFleetMachine[], rest: Partial<MeshFleetState> = {}) =>
  state({
    fleet: { callerPath: "LAN", machines },
    request: { path: "LAN", rttMs: 42 },
    ...rest,
  });

it("chooses what to show for a state", () => {
  expect(meshFleetViewKind(state({ loading: true }))).toBe("loading");
  expect(meshFleetViewKind(state({}))).toBe("loading");
  expect(
    meshFleetViewKind(state({ fleet: { callerPath: null, machines: [] }, loading: false })),
  ).toBe("empty");
  expect(meshFleetViewKind(state({ problem: { kind: "refused", status: 403 } }))).toBe("refused");
  expect(meshFleetViewKind(listed([machine("z-arch")]))).toBe("list");
  expect(
    meshFleetViewKind(listed([machine("z-arch")], { problem: { kind: "refused", status: 403 } })),
  ).toBe("list");
});

it("shows the hub request path and round-trip time above the machines", () => {
  const view = render({ state: listed([machine("z-arch")]) });
  const text = view.container.textContent ?? "";
  expect(text).toContain("Hub request path: LAN");
  expect(text).toContain("Round-trip time: 42 ms");
  expect(text).toContain(
    "This phone's last request to the hub; the viewer connection can use a different path.",
  );
  expect(text.indexOf("Hub request path")).toBeLessThan(text.indexOf("z-arch"));
  view.unmount();
});

it("shows a machine's tunnel, agent version and certificate", () => {
  const view = render({ state: listed([machine("z-arch")]) });
  const text = view.container.textContent ?? "";
  expect(text).toContain("Tunnel up");
  expect(text).toContain("Tunnel path: LAN · Up 3h 12m");
  expect(text).toContain("Agent 0.1.12");
  expect(text).toContain("Certificate expires in 90 days");
  expect(view.container.querySelector("[data-dot=connected]")).not.toBeNull();
  expect(view.container.querySelector("mark")).toBeNull();
  view.unmount();
});

it("shows an offline machine, a near certificate expiry and alerts as chips", () => {
  const view = render({
    state: listed([
      machine("z-mac", {
        online: false,
        lastSeen: NOW - 5 * 60_000,
        tunnelPath: null,
        connectedSince: null,
        agentVersion: null,
        certNotAfter: NOW + 12 * DAY,
        alerts: ["cert-expiry", "disconnected", "disk-full"],
      }),
    ]),
  });
  const text = view.container.textContent ?? "";
  expect(text).toContain("Tunnel down");
  expect(text).toContain("Seen 5m ago");
  expect(text).not.toContain("Tunnel path");
  expect(text).toContain("Agent version unknown");
  expect(text).toContain("Certificate expires in 12 days");
  expect([...view.container.querySelectorAll("mark")].map((chip) => chip.textContent)).toEqual([
    "Certificate expiring",
    "Disconnected",
    "disk-full",
  ]);
  expect(view.container.querySelector("[data-dot=available]")).not.toBeNull();
  view.unmount();
});

it("says unknown when the hub could not classify the request or the tunnel", () => {
  const view = render({
    state: listed([machine("z-arch", { tunnelPath: null, connectedSince: null })], {
      request: { path: null, rttMs: 9 },
    }),
  });
  const text = view.container.textContent ?? "";
  expect(text).toContain("Hub request path: unknown");
  expect(text).toContain("Tunnel path: unknown");
  view.unmount();
});

it("explains that online is a tunnel session, not T3 health", () => {
  const view = render({ state: listed([machine("z-arch")]) });
  expect(view.container.textContent).toContain("does not mean T3 itself is healthy");
  view.unmount();
});

it("shows the Mesh screen's problem states with their actions", () => {
  const refused = render({ state: state({ problem: { kind: "refused", status: 403 } }) });
  expect(refused.container.querySelector("h1")?.textContent).toBe(
    "The hub refused this certificate",
  );
  act(() => refused.container.querySelector("button")?.click());
  expect(refused.props.onChooseCertificate).toHaveBeenCalledOnce();
  refused.unmount();

  const down = render({
    state: state({ problem: { kind: "unavailable", message: "Network request failed" } }),
  });
  expect(down.container.textContent).toContain("Network request failed");
  act(() => down.container.querySelector("button")?.click());
  expect(down.props.onRetry).toHaveBeenCalledOnce();
  down.unmount();

  const none = render({ state: state({ problem: { kind: "no-certificate", message: null } }) });
  expect(none.container.querySelector("h1")?.textContent).toBe("Choose your mesh identity");
  none.unmount();

  const loading = render({ state: state({ loading: true }) });
  expect(loading.container.textContent).toContain("Loading fleet");
  loading.unmount();

  const empty = render({ state: state({ fleet: { callerPath: "LAN", machines: [] } }) });
  expect(empty.container.querySelector("h1")?.textContent).toBe("No machines");
  empty.unmount();
});

it("keeps the last status under a failure notice", () => {
  const view = render({
    state: listed([machine("z-arch")], { problem: { kind: "unavailable", message: "no route" } }),
    certificateWarning: "Your certificate expires soon.",
  });
  const alerts = [...view.container.querySelectorAll("[role=alert]")].map((el) => el.textContent);
  expect(alerts[0]).toBe("Your certificate expires soon.");
  expect(alerts[1]).toContain("Showing the last status.");
  expect(view.container.textContent).toContain("z-arch");
  view.unmount();
});

it("shows T3 unavailability only for an online machine with an unreachable service", () => {
  const unreachable = { state: "unreachable" as const, since: NOW - 5 * 60_000 };
  const view = render({
    state: listed([
      machine("down", { services: { t3: unreachable } }),
      machine("healthy", { services: { t3: { state: "reachable", since: NOW } } }),
      machine("absent"),
      machine("unknown", { services: { t3: { state: "unknown", since: null } } }),
      machine("offline", { online: false, services: { t3: unreachable } }),
      machine("unchecked", { services: { t3: { state: "unreachable", since: null } } }),
    ]),
  });
  const text = view.container.textContent ?? "";
  expect(text.match(/T3 unavailable/g)).toHaveLength(2);
  expect(text).toContain("T3 unavailable for 5m");
  view.unmount();
});
