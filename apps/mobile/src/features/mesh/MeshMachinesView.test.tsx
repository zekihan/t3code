import type { EnvironmentId } from "@t3tools/contracts";
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
vi.mock("../../components/ui/Notice", () => ({
  Notice: ({ message }: { message: string }) => <p role="alert">{message}</p>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; accessibilityLabel?: string; onPress: () => void }) => (
    <button aria-label={props.accessibilityLabel ?? props.label} onClick={props.onPress}>
      {props.label}
    </button>
  ),
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

import { MeshMachinesView, meshViewKind, type MeshMachinesViewProps } from "./MeshMachinesView";
import type { MeshMachine } from "./meshMachines";
import type { MeshState } from "./useMeshMachines";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-18T12:00:00Z");
const machine = (name: string, online: boolean, lastSeen: number | null): MeshMachine => ({
  name,
  online,
  lastSeen,
  viewerOrigin: `https://t3.${name}.mesh.noqer.com`,
});
const state = (overrides: Partial<MeshState>): MeshState => ({
  machines: null,
  fromCache: false,
  problem: null,
  loading: false,
  now: NOW,
  ...overrides,
});

function render(overrides: Partial<MeshMachinesViewProps> & { state: MeshState }) {
  const props: MeshMachinesViewProps = {
    now: NOW,
    paired: new Map(),
    certificateWarning: null,
    onOpen: vi.fn(),
    onPair: vi.fn(),
    onChooseCertificate: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<MeshMachinesView {...props} />));
  return { container, props, unmount: () => act(() => root.unmount()) };
}

it("shows a spinner while the first answer is pending", () => {
  const { container } = render({ state: state({ loading: true }) });
  expect(container.textContent).toContain("Loading machines");
});

it("asks for the certificate when none is selected", () => {
  const { container, props } = render({
    state: state({ problem: { kind: "no-certificate", message: null } }),
  });
  expect(container.textContent).toContain("Choose your mesh identity");
  act(() => container.querySelector("button")!.click());
  expect(props.onChooseCertificate).toHaveBeenCalledOnce();
});

it("shows the picker's own message when it failed", () => {
  const { container } = render({
    state: state({
      problem: { kind: "no-certificate", message: "A certificate picker is already open." },
    }),
  });
  expect(container.textContent).toContain("A certificate picker is already open.");
});

it("says the hub refused the certificate, and offers another one", () => {
  const { container, props } = render({
    state: state({ problem: { kind: "refused", status: 403 } }),
  });
  expect(container.textContent).toContain("The hub refused this certificate");
  expect(container.textContent).toContain("HTTP 403");
  act(() => container.querySelector("button")!.click());
  expect(props.onChooseCertificate).toHaveBeenCalledOnce();
});

it("tells a network error apart and offers a retry", () => {
  const { container, props } = render({
    state: state({ problem: { kind: "unavailable", message: "The hub did not answer in time." } }),
  });
  expect(container.textContent).toContain("Can't reach the hub");
  expect(container.textContent).toContain("The hub did not answer in time.");
  expect(container.textContent).not.toContain("refused");
  act(() => container.querySelector("button")!.click());
  expect(props.onRetry).toHaveBeenCalledOnce();
});

it("lists machines with their state, last seen time and viewer URL", () => {
  const { container } = render({
    state: state({
      machines: [machine("z-arch", true, NOW - 5 * 60_000), machine("z-mac", false, null)],
    }),
  });
  const text = container.textContent ?? "";
  expect(text).toContain("z-arch");
  expect(text).toContain("Seen 5m ago");
  expect(text).toContain("https://t3.z-arch.mesh.noqer.com");
  expect(text).toContain("Never seen");
  expect(
    [...container.querySelectorAll("[data-dot]")].map((dot) => dot.getAttribute("data-dot")),
  ).toEqual(["connected", "available"]);
});

it("opens a paired machine's environment and pairs the others", () => {
  const arch = machine("z-arch", true, NOW);
  const mac = machine("z-mac", true, NOW);
  const { container, props } = render({
    state: state({ machines: [arch, mac] }),
    paired: new Map([["z-arch", "env-1" as EnvironmentId]]),
  });
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Open z-arch"]')!.click());
  expect(props.onOpen).toHaveBeenCalledWith("env-1");
  expect(container.querySelector('[aria-label="Pair z-arch"]')).toBeNull();
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Pair z-mac"]')!.click());
  expect(props.onPair).toHaveBeenCalledWith(mac);
});

it("keeps the last list on screen beside an error", () => {
  const { container } = render({
    state: state({
      machines: [machine("z-arch", true, NOW)],
      problem: { kind: "unavailable", message: "Network request failed" },
    }),
  });
  expect(container.textContent).toContain("z-arch");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Network request failed",
  );
});

it("says so when the list is empty", () => {
  const { container } = render({ state: state({ machines: [] }) });
  expect(container.textContent).toContain("No machines");
});

it("picks the view for each state", () => {
  expect(meshViewKind(state({ loading: true }))).toBe("loading");
  expect(meshViewKind(state({ machines: [], loading: true }))).toBe("loading");
  expect(meshViewKind(state({ machines: [] }))).toBe("empty");
  expect(meshViewKind(state({ machines: [machine("a", true, null)], loading: true }))).toBe("list");
  expect(meshViewKind(state({ machines: [], problem: { kind: "refused", status: 401 } }))).toBe(
    "refused",
  );
});
