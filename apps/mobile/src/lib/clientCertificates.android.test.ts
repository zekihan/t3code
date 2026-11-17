import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getAlias: vi.fn(),
  getCertificateInfo: vi.fn(),
  events: [] as Array<{ name: string; listener: (event: unknown) => void }>,
  transfer: vi.fn(),
  createTransfer: vi.fn(() => "transfer-id"),
  cancel: vi.fn(),
  removeListener: vi.fn(),
  listener: undefined as
    | undefined
    | ((event: { id: string; bytesSent: number; totalBytes: number }) => void),
}));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({
    getAlias: mocks.getAlias,
    getCertificateInfo: mocks.getCertificateInfo,
    transfer: mocks.transfer,
    createTransfer: mocks.createTransfer,
    cancel: mocks.cancel,
    addListener: (name: string, listener: typeof mocks.listener) => {
      mocks.events.push({ name, listener: listener as (event: unknown) => void });
      mocks.listener = listener;
      return { remove: mocks.removeListener };
    },
  }),
}));
import {
  clientCertificateStatus,
  onClientCertificateIdentityProblem,
  transferWithClientCertificate,
} from "./clientCertificates.android";

const input = { url: "https://server.example/upload", fileUri: "file:///app/file", upload: true };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAlias.mockReturnValue("phone");
  mocks.transfer.mockResolvedValue({ status: 204 });
});
it("leaves ordinary destinations on their existing transport", async () => {
  mocks.getAlias.mockReturnValue(null);
  expect(
    await transferWithClientCertificate({ ...input, signal: new AbortController().signal }),
  ).toBeNull();
  expect(mocks.transfer).not.toHaveBeenCalled();
});
it("preserves an HTTP error status instead of treating it as a TLS failure", async () => {
  mocks.transfer.mockResolvedValue({ status: 401 });
  expect(
    await transferWithClientCertificate({ ...input, signal: new AbortController().signal }),
  ).toEqual({ status: 401 });
});
it("does not downgrade native certificate errors to anonymous transfers", async () => {
  mocks.transfer.mockRejectedValue(new Error("KeyChain grant revoked"));
  await expect(
    transferWithClientCertificate({ ...input, signal: new AbortController().signal }),
  ).rejects.toThrow("grant revoked");
});
it("does not start an already aborted transfer", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    transferWithClientCertificate({ ...input, signal: controller.signal }),
  ).rejects.toThrow();
  expect(mocks.transfer).not.toHaveBeenCalled();
});
it("cancels the native operation and releases its progress listener", async () => {
  const controller = new AbortController();
  let finish!: (value: { status: number }) => void;
  mocks.transfer.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = transferWithClientCertificate({
    ...input,
    signal: controller.signal,
    onProgress: vi.fn(),
  });
  controller.abort();
  expect(mocks.cancel).toHaveBeenCalledWith("transfer-id");
  finish({ status: 204 });
  await expect(pending).rejects.toThrow();
  expect(mocks.removeListener).toHaveBeenCalledOnce();
});
it("reports only this transfer's progress", async () => {
  const progress = vi.fn();
  mocks.transfer.mockImplementation(async () => {
    mocks.listener?.({ id: "other", bytesSent: 9, totalBytes: 10 });
    mocks.listener?.({ id: "transfer-id", bytesSent: 5, totalBytes: 10 });
    return { status: 204 };
  });
  await transferWithClientCertificate({
    ...input,
    signal: new AbortController().signal,
    onProgress: progress,
  });
  expect(progress).toHaveBeenCalledExactlyOnceWith(0.5);
  expect(mocks.removeListener).toHaveBeenCalledOnce();
});

it("releases native registration when aborted before the queued transfer starts", async () => {
  const controller = new AbortController();
  mocks.createTransfer.mockImplementationOnce(() => {
    controller.abort();
    return "transfer-id";
  });
  await expect(
    transferWithClientCertificate({ ...input, signal: controller.signal }),
  ).rejects.toThrow();
  expect(mocks.transfer).not.toHaveBeenCalled();
  expect(mocks.cancel).toHaveBeenCalledWith("transfer-id");
});

it("works with React Native signals without throwIfAborted", async () => {
  const controller = new AbortController();
  Object.defineProperty(controller.signal, "throwIfAborted", { value: undefined });
  expect(await transferWithClientCertificate({ ...input, signal: controller.signal })).toEqual({
    status: 204,
  });
  controller.abort();
  await expect(
    transferWithClientCertificate({ ...input, signal: controller.signal }),
  ).rejects.toThrow("cancelled");
});

it("reads the selected certificate's status and expiry from native", async () => {
  mocks.getCertificateInfo.mockResolvedValue({ state: "valid", notAfter: 1_800_000_000_000 });
  expect(await clientCertificateStatus("https://server.example")).toEqual({
    state: "valid",
    notAfter: 1_800_000_000_000,
  });
  expect(mocks.getCertificateInfo).toHaveBeenCalledWith("https://server.example");
});

it("forwards identity problems reported by the native transport", () => {
  const problem = vi.fn();
  onClientCertificateIdentityProblem(problem);
  const registered = mocks.events.find((event) => event.name === "identityProblem");
  registered?.listener({ origin: "https://server.example/", reason: "missing" });
  expect(problem).toHaveBeenCalledExactlyOnceWith({
    origin: "https://server.example/",
    reason: "missing",
  });
});
