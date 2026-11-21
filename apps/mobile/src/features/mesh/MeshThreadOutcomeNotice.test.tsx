import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { environmentCatalog } from "../../connection/catalog";
import { environmentThreads } from "../../state/threads";
import { MeshThreadOutcomeNotice } from "./MeshThreadOutcomeNotice";
import type { DirectChangedEvent, DirectStatus } from "./meshDirect.types";

const mocks = vi.hoisted(() => ({
  getDirectStatus: vi.fn(),
  listeners: new Set<(event: DirectChangedEvent) => void>(),
  checkRefresh: vi.fn(),
  origin: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    loading,
    onPress,
  }: {
    label: string;
    loading: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={loading} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentCatalog: { catalogValueAtom: Atom.make({ entries: new Map() }) } };
});
vi.mock("@t3tools/client-runtime/connection", () => ({
  connectionRoutes: () => [{}],
  routeHttpBaseUrl: () => mocks.origin(),
}));
vi.mock("../../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});
vi.mock("../../state/threads", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const detail = Atom.make(AsyncResult.success({ status: "live", sequence: 5 }));
  return { environmentThreads: { stateAtom: () => detail } };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.checkRefresh }));
vi.mock("./meshDirect", () => ({
  directAvailable: true,
  getDirectStatus: mocks.getDirectStatus,
  onDirectChanged: (listener: (event: DirectChangedEvent) => void) => {
    mocks.listeners.add(listener);
    return { remove: () => mocks.listeners.delete(listener) };
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = "https://t3.z-arch.mesh.noqer.com";
const THREAD = {
  environmentId: EnvironmentId.make("mesh"),
  threadId: ThreadId.make("thread"),
};
const WARNING = "The last request may have reached the machine. Check the thread before resending.";

function setup() {
  vi.resetAllMocks();
  mocks.origin.mockReturnValue(ORIGIN);
  mocks.getDirectStatus.mockResolvedValue({ unknownOutcome: { at: 100, method: "POST" } });
  const registry = AtomRegistry.make();
  const catalog = environmentCatalog.catalogValueAtom as unknown as Atom.Writable<{
    entries: ReadonlyMap<EnvironmentId, object>;
  }>;
  registry.set(catalog, { entries: new Map([[THREAD.environmentId, {}]]) });
  const detail = environmentThreads.stateAtom(
    THREAD.environmentId,
    THREAD.threadId,
  ) as unknown as Atom.Writable<AsyncResult.AsyncResult<{ status: string; sequence: number }>>;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (threadRef = THREAD) =>
    act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <MeshThreadOutcomeNotice threadRef={threadRef} />
        </RegistryContext.Provider>,
      ),
    );
  return {
    container,
    render,
    setOutcome: (unknownOutcome: DirectStatus["unknownOutcome"]) =>
      act(async () => {
        mocks.getDirectStatus.mockResolvedValue({ unknownOutcome });
        for (const listener of mocks.listeners) listener({ origin: ORIGIN, machine: "z-arch" });
      }),
    setStatus: (status: string, timestamp: number) =>
      act(() => registry.set(detail, AsyncResult.success({ status, sequence: 5 }, { timestamp }))),
    close: () => {
      act(() => root.unmount());
      registry.dispose();
    },
  };
}

it("shows the warning only for a mesh environment with an outstanding outcome", async () => {
  const view = setup();
  try {
    await view.render({ ...THREAD, environmentId: EnvironmentId.make("other") });
    expect(view.container.textContent).toBe("");
    expect(mocks.getDirectStatus).not.toHaveBeenCalled();

    await view.render();
    expect(mocks.getDirectStatus).toHaveBeenCalledWith(ORIGIN);
    expect(view.container.textContent).toContain(WARNING);

    await view.setOutcome(null);
    expect(view.container.textContent).toBe("");
  } finally {
    view.close();
  }
});

it("refreshes the selected thread and keeps the warning until the check succeeds", async () => {
  const view = setup();
  using _now = vi.spyOn(Date, "now").mockReturnValue(110);
  try {
    await view.render();
    mocks.checkRefresh.mockResolvedValueOnce({ _tag: "Success", value: false });
    const refresh = view.container.querySelector("button");
    expect(refresh?.textContent).toBe("Refresh thread");
    await act(async () => refresh?.click());
    expect(mocks.checkRefresh).toHaveBeenCalledWith({
      environmentId: THREAD.environmentId,
      input: THREAD.threadId,
    });
    expect(view.container.textContent).toContain(WARNING);

    mocks.checkRefresh.mockResolvedValueOnce({ _tag: "Success", value: true });
    await act(async () => refresh?.click());
    expect(view.container.textContent).toBe("");

    await view.render({ ...THREAD, threadId: ThreadId.make("another-thread") });
    expect(view.container.textContent).toContain(WARNING);
    await view.render();
    expect(view.container.textContent).toBe("");

    await view.setOutcome({ at: 120, method: "POST" });
    expect(view.container.textContent).toContain(WARNING);
  } finally {
    view.close();
  }
});

it("clears when the thread finishes synchronizing after the outcome", async () => {
  const view = setup();
  try {
    await view.render();
    view.setStatus("live", 105);
    expect(view.container.textContent).toContain(WARNING);
    view.setStatus("synchronizing", 110);
    expect(view.container.textContent).toContain(WARNING);
    view.setStatus("live", 120);
    expect(view.container.textContent).toBe("");
  } finally {
    view.close();
  }
});
