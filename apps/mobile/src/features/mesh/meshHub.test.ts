import { expect, it, vi } from "vite-plus/test";

vi.mock("../../lib/clientCertificates", () => ({
  clientCertificatesAvailable: true,
  selectedClientCertificate: vi.fn(() => "hub-id"),
}));

import { fetchMeshFleet, fetchMeshMachines } from "./meshHub";
import { MESH_FLEET_URL, MESH_MACHINES_URL } from "./meshViewerUrl";

const arch = {
  name: "z-arch",
  online: true,
  lastSeen: null,
  viewerUrl: "https://t3.z-arch.mesh.noqer.com",
};
const respond = (status: number, body: unknown = {}) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

it("asks the hub's machines endpoint and returns the validated list", async () => {
  const fetch = respond(200, {
    machines: [arch, { ...arch, name: "evil", viewerUrl: "https://t3.evil.example" }],
  });
  const result = await fetchMeshMachines({ fetch, hasCertificate: () => true });
  expect(fetch).toHaveBeenCalledWith(
    MESH_MACHINES_URL,
    expect.objectContaining({ headers: { accept: "application/json" } }),
  );
  expect(result.kind === "ok" && result.machines.map((machine) => machine.name)).toEqual([
    "z-arch",
  ]);
});

it("makes no request without a certificate", async () => {
  const fetch = respond(200);
  expect(await fetchMeshMachines({ fetch, hasCertificate: () => false })).toEqual({
    kind: "no-certificate",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([401, 403])("reports HTTP %i as refused by the hub", async (status) => {
  expect(await fetchMeshMachines({ fetch: respond(status), hasCertificate: () => true })).toEqual({
    kind: "refused",
    status,
  });
});

it("reports other statuses and unreadable answers as the hub being unavailable", async () => {
  const bad = await fetchMeshMachines({ fetch: respond(502), hasCertificate: () => true });
  expect(bad).toEqual({ kind: "unavailable", message: "The hub answered HTTP 502." });
  const shape = await fetchMeshMachines({
    fetch: respond(200, { error: "x" }),
    hasCertificate: () => true,
  });
  expect(shape.kind).toBe("unavailable");
  const html = await fetchMeshMachines({
    fetch: vi.fn(async () => new Response("<html>", { status: 200 })),
    hasCertificate: () => true,
  });
  expect(html.kind).toBe("unavailable");
});

it("reports a network failure with its message", async () => {
  const fetch = vi.fn(async () => {
    throw new TypeError("Network request failed");
  });
  expect(await fetchMeshMachines({ fetch, hasCertificate: () => true })).toEqual({
    kind: "unavailable",
    message: "Network request failed",
  });
});

it("gives up after the timeout", async () => {
  vi.useFakeTimers();
  try {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = fetchMeshMachines({
      fetch: fetch as unknown as typeof globalThis.fetch,
      hasCertificate: () => true,
      timeoutMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({
      kind: "unavailable",
      message: "The hub did not answer in time.",
    });
  } finally {
    vi.useRealTimers();
  }
});

const fleetBody = {
  caller: { path: "LAN" },
  machines: [
    {
      ...arch,
      agentVersion: "0.1.12",
      certNotAfter: null,
      tunnel: { path: "LAN", connectedSince: null },
      alerts: [],
    },
  ],
};

it("asks the fleet endpoint and times the request to its headers, not the JSON parse", async () => {
  let clock = 1_000;
  const response = new Response(JSON.stringify(fleetBody), { status: 200 });
  const parse = response.json.bind(response);
  response.json = async () => {
    clock += 500;
    return parse();
  };
  const fetch = vi.fn(async () => {
    clock += 42;
    return response;
  });
  const result = await fetchMeshFleet({
    fetch,
    hasCertificate: () => true,
    now: () => clock,
  });
  expect(fetch).toHaveBeenCalledWith(
    MESH_FLEET_URL,
    expect.objectContaining({ headers: { accept: "application/json" } }),
  );
  expect(result.kind === "ok" && result.rttMs).toBe(42);
  expect(result.kind === "ok" && result.fleet.callerPath).toBe("LAN");
  expect(result.kind === "ok" && result.fleet.machines.map((machine) => machine.name)).toEqual([
    "z-arch",
  ]);
});

it("makes no fleet request without a certificate and reports refusals and bad answers", async () => {
  const none = respond(200);
  expect(await fetchMeshFleet({ fetch: none, hasCertificate: () => false })).toEqual({
    kind: "no-certificate",
  });
  expect(none).not.toHaveBeenCalled();
  expect(await fetchMeshFleet({ fetch: respond(403), hasCertificate: () => true })).toEqual({
    kind: "refused",
    status: 403,
  });
  expect(await fetchMeshFleet({ fetch: respond(502), hasCertificate: () => true })).toEqual({
    kind: "unavailable",
    message: "The hub answered HTTP 502.",
  });
  expect(
    await fetchMeshFleet({ fetch: respond(200, { machines: "x" }), hasCertificate: () => true }),
  ).toEqual({ kind: "unavailable", message: "The hub's answer was not a fleet status." });
});
