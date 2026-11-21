import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("@react-navigation/native", () => ({ useFocusEffect: vi.fn() }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
vi.mock("../../lib/clientCertificates", () => ({ clientCertificatesAvailable: true }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: vi.fn(),
}));
vi.mock("./meshStore", () => ({ loadCachedMeshMachines: vi.fn() }));
vi.mock("./useMeshPairing", () => ({ useMeshPairing: vi.fn() }));

import { MeshHomeMachinesList } from "./MeshHomeMachines";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("hides the empty section and pairs the machine selected in the list", () => {
  const machines = ["z-arch", "z-mac"].map((name) => ({
    name,
    online: true,
    lastSeen: null,
    viewerOrigin: `https://t3.${name}.mesh.noqer.com`,
  }));
  const onPair = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    act(() => root.render(<MeshHomeMachinesList machines={[]} onPair={onPair} />));
    expect(container.textContent).toBe("");

    act(() => root.render(<MeshHomeMachinesList machines={machines} onPair={onPair} />));
    expect(container.textContent).toContain("Unpaired mesh machines");
    expect(container.textContent).toContain("z-arch");
    expect(container.textContent).toContain("z-mac");
    const buttons = container.querySelectorAll("button");
    expect(Array.from(buttons, (button) => button.textContent)).toEqual(["Pair", "Pair"]);
    act(() => buttons[1]!.click());
    expect(onPair).toHaveBeenCalledExactlyOnceWith(machines[1]);
  } finally {
    act(() => root.unmount());
  }
});
