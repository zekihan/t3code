import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { createMeshDiagnosticsRunner, openDiagnosticWebSocket } from "./meshDiagnostics";
import type { DirectDiagnostics } from "./meshDirect.types";

const target = {
  environmentId: EnvironmentId.make("saved"),
  origin: "https://t3.host.mesh.noqer.com",
};
const direct: DirectDiagnostics = {
  path: "viewer",
  reason: "probe-failed",
  trustFetchedAt: 1000,
  homeCheck: { at: 2000, result: "home" },
  probe: { at: 3000, result: "timeout" },
};

it("checks factory ownership, both hub endpoints and every saved mesh target even if the hub fails", async () => {
  const calls: string[] = [];
  const openSocket = vi.fn(async () => {
    calls.push("socket");
    return { state: "pass", code: "socket-opened" } as const;
  });
  const runner = createMeshDiagnosticsRunner({
    factoryInstalled: () => {
      calls.push("factory");
      return false;
    },
    fetchMachines: async () => {
      calls.push("machines");
      return { kind: "no-certificate" };
    },
    fetchFleet: async () => {
      calls.push("fleet");
      return { kind: "refused", status: 403 };
    },
    readDirect: async () => {
      calls.push("direct");
      return direct;
    },
    openSocket,
    probe: vi.fn(),
    readLog: async () => [],
  });
  const { signal } = new AbortController();
  const secondOrigin = { ...target, origin: "https://t3.other.mesh.noqer.com" };
  const secondEnvironment = { ...secondOrigin, environmentId: EnvironmentId.make("other") };
  const report = await runner.run([target, secondOrigin, secondEnvironment], signal);

  expect(calls[0]).toBe("factory");
  expect(calls.indexOf("direct")).toBeGreaterThan(calls.lastIndexOf("socket"));
  expect(openSocket.mock.calls).toEqual([
    [target, signal],
    [secondEnvironment, signal],
  ]);
  expect(report).toMatchObject({
    transport: { state: "fail", code: "factory-replaced" },
    machines: { state: "skipped", code: "no-certificate" },
    fleet: { state: "fail", code: "refused", httpStatus: 403 },
    paired: [
      { ...target, socket: { state: "pass" }, direct },
      { ...secondOrigin, socket: { state: "pass" }, direct },
      { ...secondEnvironment, socket: { state: "pass" }, direct },
    ],
  });
});

it("returns the on-demand result and rereads the direct state and log", async () => {
  const probe = vi
    .fn<(origin: string) => Promise<string | null>>()
    .mockResolvedValueOnce("authorization")
    .mockResolvedValueOnce("away")
    .mockResolvedValueOnce("ok");
  const log = [{ at: 3000, kind: "probe", result: "timeout", host: "t3.host.mesh.noqer.com" }];
  const runner = createMeshDiagnosticsRunner({
    factoryInstalled: () => true,
    fetchMachines: vi.fn(),
    fetchFleet: vi.fn(),
    readDirect: async () => direct,
    openSocket: vi.fn(),
    probe,
    readLog: async () => log,
  });
  expect(await runner.test(target.origin)).toEqual({
    test: { state: "fail", code: "authorization" },
    direct,
    log,
  });
  expect((await runner.test(target.origin)).test).toEqual({ state: "skipped", code: "away" });
  expect((await runner.test(target.origin)).test).toEqual({ state: "pass", code: "ok" });
  expect(probe).toHaveBeenCalledWith(target.origin);
});

class TestSocket extends EventTarget {
  readonly close = vi.fn();
  readonly send = vi.fn();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("closes after open without sending an RPC frame", async () => {
  const socket = new TestSocket();
  vi.stubGlobal(
    "WebSocket",
    vi.fn(function () {
      return socket;
    }),
  );
  const check = openDiagnosticWebSocket(
    "wss://t3.host.mesh.noqer.com/ws",
    new AbortController().signal,
  );
  socket.dispatchEvent(new Event("open"));
  expect(await check).toEqual({ state: "pass", code: "socket-opened" });
  expect(socket.close).toHaveBeenCalledOnce();
  expect(socket.send).not.toHaveBeenCalled();
});

it("reports a timeout and still closes a late React Native upgrade", async () => {
  vi.useFakeTimers();
  const socket = new TestSocket();
  vi.stubGlobal(
    "WebSocket",
    vi.fn(function () {
      return socket;
    }),
  );
  const check = openDiagnosticWebSocket(
    "wss://t3.host.mesh.noqer.com/ws",
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(12_000);
  expect(await check).toEqual({ state: "fail", code: "socket-timeout" });
  socket.dispatchEvent(new Event("open"));
  expect(socket.close).toHaveBeenCalledOnce();
});
