import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  selected: vi.fn(),
  status: vi.fn(),
  listeners: new Set<() => void>(),
}));
vi.mock("../../lib/clientCertificates", () => ({
  selectedClientCertificate: mocks.selected,
  clientCertificateStatus: mocks.status,
  onClientCertificateChange: (listener: () => void) => {
    mocks.listeners.add(listener);
    return { remove: () => mocks.listeners.delete(listener) };
  },
}));
import { useClientCertificateStatus } from "./useClientCertificateStatus";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latest: ReturnType<typeof useClientCertificateStatus>;
function Probe(props: { readonly refreshKey?: number }) {
  const value = useClientCertificateStatus("https://env.example/", props.refreshKey);
  useLayoutEffect(() => {
    latest = value;
  });
  return null;
}

beforeEach(() => {
  mocks.listeners.clear();
  vi.resetAllMocks();
});

it("has no status without a selected certificate", async () => {
  mocks.selected.mockReturnValue(null);
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  expect(latest).toEqual({ alias: null, status: null });
  expect(mocks.status).not.toHaveBeenCalled();
  act(() => root.unmount());
});

it("reads the status again when the key changes, because the alias stays while the grant goes", async () => {
  mocks.selected.mockReturnValue("phone");
  mocks.status.mockResolvedValue({ state: "valid", notAfter: null });
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe refreshKey={1} />));
  expect(latest.status).toEqual({ state: "valid", notAfter: null });
  mocks.status.mockResolvedValue({ state: "missing", notAfter: null });
  await act(async () => root.render(<Probe refreshKey={2} />));
  expect(latest).toEqual({ alias: "phone", status: { state: "missing", notAfter: null } });
  act(() => root.unmount());
});

it("reads the status again when KeyChain reports a change", async () => {
  mocks.selected.mockReturnValue("phone");
  mocks.status.mockResolvedValue({ state: "missing", notAfter: null });
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  expect(latest.status?.state).toBe("missing");
  mocks.status.mockResolvedValue({ state: "valid", notAfter: null });
  await act(async () => mocks.listeners.forEach((listener) => listener()));
  expect(latest.status?.state).toBe("valid");
  act(() => root.unmount());
});

it("drops the status when the status lookup fails", async () => {
  mocks.selected.mockReturnValue("phone");
  mocks.status.mockRejectedValue(new Error("boom"));
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  expect(latest).toEqual({ alias: "phone", status: null });
  act(() => root.unmount());
});
