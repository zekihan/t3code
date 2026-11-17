import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  selected: vi.fn(),
  load: vi.fn(),
}));
vi.mock("../../lib/clientCertificates", () => ({
  selectedClientCertificate: mocks.selected,
  onClientCertificateChange: () => ({ remove() {} }),
}));
vi.mock("../../lib/certificateMedia", () => ({
  loadCertificateMedia: mocks.load,
  certificateMediaExtension: (uri: string, fallback = "") =>
    /\.[a-z0-9]+$/i.exec(new URL(uri).pathname)?.[0] ?? fallback,
}));
import {
  certificateNavigationAllowed,
  certificateWebViewProps,
  useCertificateLocalUri,
  useCertificateMediaLease,
  type CertificateLocalUri,
} from "./useCertificateLocalUri";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latest: CertificateLocalUri;
function Probe(props: { readonly uri: string | null }) {
  const value = useCertificateLocalUri(props.uri);
  useLayoutEffect(() => {
    latest = value;
  });
  return null;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.selected.mockReturnValue("phone");
});

it("returns an unprotected URL unchanged and never downloads it", async () => {
  mocks.selected.mockReturnValue(null);
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe uri="https://public.example/page.html" />));
  expect(latest).toEqual({
    state: "ready",
    uri: "https://public.example/page.html",
    local: false,
  });
  expect(mocks.load).not.toHaveBeenCalled();
  act(() => root.unmount());
});

it("loads a protected page from a private file with its own extension and deletes it on unmount", async () => {
  const dispose = vi.fn();
  mocks.load.mockResolvedValue({ uri: "file:///cache/t3-mtls-media-1.svg", dispose });
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe uri="https://env.example/a/shot.svg?sig=1" />));
  expect(mocks.load).toHaveBeenCalledWith(
    "https://env.example/a/shot.svg?sig=1",
    expect.any(AbortSignal),
    { extension: ".svg" },
  );
  expect(latest).toEqual({
    state: "ready",
    uri: "file:///cache/t3-mtls-media-1.svg",
    local: true,
  });
  expect(dispose).not.toHaveBeenCalled();
  act(() => root.unmount());
  expect(dispose).toHaveBeenCalledOnce();
});

it("never falls back to the environment URL when the download fails", async () => {
  mocks.load.mockRejectedValue(new Error("HTTP 401"));
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe uri="https://env.example/page" />));
  expect(latest).toEqual({ state: "failed", uri: null, local: true });
  act(() => root.unmount());
});

it("waits with no URL for the WebView while the download runs", async () => {
  mocks.load.mockReturnValue(new Promise(() => {}));
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe uri="https://env.example/page.html" />));
  expect(latest).toEqual({ state: "loading", uri: null, local: true });
  act(() => root.unmount());
});

it("deletes a file that finished after the view went away", async () => {
  const dispose = vi.fn();
  let finish: (media: { uri: string; dispose(): void }) => void = () => {};
  mocks.load.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe uri="https://env.example/page.html" />));
  act(() => root.unmount());
  await act(async () => finish({ uri: "file:///cache/late.html", dispose }));
  expect(dispose).toHaveBeenCalledOnce();
});

it("keeps a leased page from navigating to other files", () => {
  const local: CertificateLocalUri = { state: "ready", uri: "file:///cache/a.html", local: true };
  const remote: CertificateLocalUri = { state: "ready", uri: "https://x/a.html", local: false };
  expect(certificateNavigationAllowed(local, "file:///cache/a.html#top")).toBe(true);
  expect(certificateNavigationAllowed(local, "file:///data/user/0/app/databases/db")).toBe(false);
  expect(certificateNavigationAllowed(local, "https://example.com/")).toBe(true);
  expect(certificateNavigationAllowed(remote, "file:///anything")).toBe(true);
  expect(certificateWebViewProps(local)).toEqual({ allowFileAccess: true, originWhitelist: ["*"] });
  expect(certificateWebViewProps(remote)).toEqual({});
});

let lease: ReturnType<typeof useCertificateMediaLease>;
function LeaseProbe() {
  const value = useCertificateMediaLease();
  useLayoutEffect(() => {
    lease = value;
  });
  return null;
}

it("replaces the audio lease on each request and releases the last on unmount", async () => {
  const first = { uri: "file:///cache/one", dispose: vi.fn() };
  const second = { uri: "file:///cache/two", dispose: vi.fn() };
  mocks.load.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<LeaseProbe />));
  await expect(lease("https://env.example/a.mp3")).resolves.toBe("file:///cache/one");
  expect(first.dispose).not.toHaveBeenCalled();
  await expect(lease("https://env.example/b.mp3")).resolves.toBe("file:///cache/two");
  expect(first.dispose).toHaveBeenCalledOnce();
  expect(second.dispose).not.toHaveBeenCalled();
  act(() => root.unmount());
  expect(second.dispose).toHaveBeenCalledOnce();
});

it("drops a lease whose request was superseded", async () => {
  const stale = { uri: "file:///cache/stale", dispose: vi.fn() };
  const fresh = { uri: "file:///cache/fresh", dispose: vi.fn() };
  let finishStale: (media: typeof stale) => void = () => {};
  mocks.load
    .mockReturnValueOnce(new Promise((resolve) => (finishStale = resolve)))
    .mockResolvedValueOnce(fresh);
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<LeaseProbe />));
  const superseded = lease("https://env.example/a.mp3");
  const rejected = expect(superseded).rejects.toThrow("cancelled");
  await expect(lease("https://env.example/b.mp3")).resolves.toBe("file:///cache/fresh");
  finishStale(stale);
  await rejected;
  expect(stale.dispose).toHaveBeenCalledOnce();
  expect(fresh.dispose).not.toHaveBeenCalled();
  act(() => root.unmount());
});
