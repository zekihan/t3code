import type { SharePayload } from "expo-sharing";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  selected: vi.fn(),
}));
vi.mock("expo/fetch", () => ({ fetch: mocks.fetch }));
vi.mock("../../lib/clientCertificates", () => ({
  clientCertificatesAvailable: true,
  selectedClientCertificate: mocks.selected,
}));

import { resolveMeshSharedThread } from "./meshSharedThread";

const origin = "https://t3.z-arch.mesh.noqer.com";
const environmentId = "dbbc111b-8872-4f7b-8af0-dfcc8d7ccb29";
const direct = `${origin}/${environmentId}/thread%3Aid?source=share#anchor`;
const hosted = `${origin}/threads/env-1/thread%3Aid`;
const payload = (value: string, shareType: SharePayload["shareType"] = "url"): SharePayload => ({
  value,
  shareType,
  mimeType: "text/plain",
});
const paired = (id: string) => id === environmentId || id === "env-1";
const setup = () => {
  mocks.selected.mockReset().mockReturnValue("device");
  mocks.fetch.mockReset().mockResolvedValue({ ok: true });
};

it.each([
  [direct, environmentId, "url", direct.split("#")[0]],
  [hosted, "env-1", "text", hosted],
] as const)(
  "probes the exact mesh thread URL %s using the origin's certificate",
  async (url, id, type, probeUrl) => {
    setup();
    await expect(resolveMeshSharedThread([payload(url, type)], paired)).resolves.toEqual({
      environmentId: id,
      threadId: "thread:id",
    });
    expect(mocks.selected).toHaveBeenCalledExactlyOnceWith(origin);
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(
      probeUrl,
      expect.objectContaining({ method: "HEAD", credentials: "omit", redirect: "error" }),
    );
  },
);

it("recognizes a direct thread URL with a custom paired environment ID", async () => {
  setup();
  await expect(
    resolveMeshSharedThread([payload(`${origin}/custom/thread-1`)], (id) => id === "custom"),
  ).resolves.toEqual({ environmentId: "custom", threadId: "thread-1" });
});

it.each([
  [payload("https://app.t3.codes/threads/env-1/thread-1")],
  [payload("https://t3.z-arch.mesh.noqer.com.example.com/threads/env-1/thread-1")],
  [payload("https://user@t3.z-arch.mesh.noqer.com/threads/env-1/thread-1")],
  [payload(`${origin}/settings/diagnostics`)],
  [payload(`${origin}/threads/env-1/%ZZ`)],
  [payload(`Subject: ${direct}`, "text")],
  [payload(direct), payload("content://shared-image", "image")],
])("leaves other shares to the composer without probing", (...payloads) => {
  setup();
  return expect(resolveMeshSharedThread(payloads, paired))
    .resolves.toBeNull()
    .then(() => {
      expect(mocks.selected).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    });
});

it("leaves a thread on an unpaired machine to the composer without probing", async () => {
  setup();
  await expect(resolveMeshSharedThread([payload(hosted)], () => false)).resolves.toBeNull();
  expect(mocks.selected).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("explains how to select a missing certificate without probing", async () => {
  setup();
  mocks.selected.mockReturnValue(null);
  await expect(resolveMeshSharedThread([payload(direct)], paired)).rejects.toThrow(
    /needs this device's client certificate.*[Ss]elect/,
  );
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("shows certificate recovery guidance when TLS negotiation fails", async () => {
  setup();
  mocks.fetch.mockRejectedValue(new Error("SSLHandshakeException"));
  await expect(resolveMeshSharedThread([payload(direct)], paired)).rejects.toThrow(
    /needs this device's client certificate.*retry/,
  );
});

it("shows certificate recovery guidance when the viewer refuses the probe", async () => {
  setup();
  mocks.fetch.mockResolvedValue({ ok: false, status: 403 });
  await expect(resolveMeshSharedThread([payload(direct)], paired)).rejects.toThrow(
    /needs this device's client certificate.*retry/,
  );
});
