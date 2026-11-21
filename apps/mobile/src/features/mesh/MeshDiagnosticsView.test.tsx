import { EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ share: vi.fn() }));
const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
vi.mock("react-native", () => ({
  Modal: (props: { children?: ReactNode }) => <Container {...props} />,
  View: (props: { children?: ReactNode }) => <Container {...props} />,
  Share: mocks,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <Container {...props} />,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: (props: { children?: ReactNode }) => <Container {...props} />,
}));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: ({ title, children }: { title: string; children?: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/SheetHeader", () => ({
  SheetHeader: ({
    title,
    actions,
    onClose,
  }: {
    title: string;
    actions: readonly { accessibilityLabel: string; disabled?: boolean; onPress: () => void }[];
    onClose: () => void;
  }) => (
    <header>
      {title}
      <button type="button" onClick={onClose}>
        Close
      </button>
      {actions.map(({ accessibilityLabel, disabled, onPress }) => (
        <button type="button" key={accessibilityLabel} disabled={disabled} onClick={onPress}>
          {accessibilityLabel}
        </button>
      ))}
    </header>
  ),
}));

import { MeshDiagnosticsView } from "./MeshDiagnosticsView";
import type { MeshDiagnostics } from "./meshDiagnostics";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shows checks, refreshes the selected probe and shares the sanitized report", async () => {
  mocks.share.mockReset();
  const container = document.createElement("div");
  const root = createRoot(container);
  const origin = "https://t3.dev.mesh.noqer.com";
  const target = { origin, environmentId: EnvironmentId.make("dev") };
  const direct = {
    path: "viewer",
    reason: "probe-failed",
    homeCheck: { at: 60_000, result: "home" },
    probe: { at: 120_000, result: "timeout" },
    trustFetchedAt: 0,
  } as const;
  const report: MeshDiagnostics = {
    at: 180_000,
    transport: { state: "fail", code: "factory-replaced" },
    machines: { state: "pass", code: "ok" },
    fleet: { state: "skipped", code: "no-certificate" },
    paired: [{ ...target, direct, socket: { state: "fail", code: "socket-timeout" } }],
    log: [],
  };
  const run = vi.fn(async (_targets, _signal: AbortSignal) => report);
  const test = vi.fn(
    async () =>
      ({
        direct: { ...direct, path: "direct", reason: null, probe: { at: 180_000, result: "ok" } },
        test: { state: "pass", code: "ok" },
        log: [{ at: 180_000, kind: "probe", result: "ok", host: "t3.dev.mesh.noqer.com" }],
      }) as const,
  );
  const onClose = vi.fn();
  const button = (label: string) =>
    Array.from(container.querySelectorAll("button")).find((node) => node.textContent === label);
  try {
    await act(async () =>
      root.render(
        <MeshDiagnosticsView
          runner={{ run, test }}
          getTargets={() => [target]}
          onClose={onClose}
        />,
      ),
    );

    expect(run.mock.calls[0]?.[0]).toEqual([target]);
    expect(container.textContent).toContain(
      "The certificate transport no longer owns the OkHttp factory.",
    );
    expect(container.textContent).toContain("/api/v1/machinesPass");
    expect(container.textContent).toContain("/api/v1/fleetSkipped");
    expect(container.textContent).toContain("Trust bundle age: 3 min");
    expect(container.textContent).toContain("Last home check: home");
    expect(container.textContent).toContain("Last direct probe: timeout");

    await act(async () => button("Test direct path now")?.click());
    expect(test).toHaveBeenCalledWith(origin);
    expect(container.textContent).toContain("On-demand direct probePass");
    expect(container.textContent).toContain("probe t3.dev.mesh.noqer.com: ok");

    await act(async () => button("Share report")?.click());
    expect(mocks.share).toHaveBeenCalledWith({
      message: expect.stringContaining("On-demand direct probe: pass · ok"),
    });
    expect(mocks.share.mock.calls[0]?.[0].message).toContain("WebSocket: fail · socket-timeout");

    act(() => button("Close")?.click());
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
  expect(run.mock.calls[0]?.[1].aborted).toBe(true);
});
