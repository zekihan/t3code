import type { EnvironmentId } from "@t3tools/contracts";

import type { DirectDecisionEntry, DirectDiagnostics } from "./meshDirect.types";
import type { MeshFetchResult, MeshFleetFetchResult } from "./meshHub";

export interface DiagnosticTarget {
  readonly environmentId: EnvironmentId;
  readonly origin: string;
}

export type CheckState = "pass" | "fail" | "skipped";

export interface DiagnosticCheck {
  readonly state: CheckState;
  readonly code: string;
  readonly detail?: string;
  readonly httpStatus?: number;
}

export interface MachineDiagnostics extends DiagnosticTarget {
  readonly direct: DirectDiagnostics | null;
  readonly socket: DiagnosticCheck;
  readonly test?: DiagnosticCheck;
}

export interface MeshDiagnostics {
  readonly at: number;
  readonly transport: DiagnosticCheck;
  readonly machines: DiagnosticCheck;
  readonly fleet: DiagnosticCheck;
  readonly paired: readonly MachineDiagnostics[];
  readonly log: readonly DirectDecisionEntry[];
}

export const PROBE_FAILURES: readonly string[] = [
  "certificate",
  "authorization",
  "unreachable",
  "timeout",
  "unexpected",
];

function hubCheck(result: MeshFetchResult | MeshFleetFetchResult): DiagnosticCheck {
  switch (result.kind) {
    case "ok":
      return { state: "pass", code: "ok" };
    case "no-certificate":
      return { state: "skipped", code: "no-certificate" };
    case "refused":
      return { state: "fail", code: "refused", httpStatus: result.status };
    case "unavailable":
      return { state: "fail", code: "unavailable", detail: result.message };
  }
}

export function directCheck(direct: DirectDiagnostics | null): DiagnosticCheck {
  if (!direct) return { state: "skipped", code: "unsupported" };
  if (direct.path === "direct") return { state: "pass", code: "direct" };
  return {
    state: direct.reason === "probe-failed" ? "fail" : "skipped",
    code: direct.reason ?? "pending",
  };
}

interface DiagnosticsDeps {
  readonly factoryInstalled: () => boolean | null;
  readonly fetchMachines: () => Promise<MeshFetchResult>;
  readonly fetchFleet: () => Promise<MeshFleetFetchResult>;
  readonly readDirect: (origin: string) => Promise<DirectDiagnostics | null>;
  readonly readLog: () => Promise<readonly DirectDecisionEntry[]>;
  readonly probe: (origin: string) => Promise<string | null>;
  readonly openSocket: (target: DiagnosticTarget, signal: AbortSignal) => Promise<DiagnosticCheck>;
}

const unexpected: DiagnosticCheck = { state: "fail", code: "unexpected" };

export function createMeshDiagnosticsRunner(deps: DiagnosticsDeps) {
  return {
    async run(targets: readonly DiagnosticTarget[], signal: AbortSignal): Promise<MeshDiagnostics> {
      const checks = new Map<EnvironmentId, Promise<DiagnosticCheck>>();
      // Observe the factory before any network work, without reinstalling it.
      const transport = await Promise.resolve()
        .then(() => {
          const installed = deps.factoryInstalled();
          if (installed === null) return { state: "skipped", code: "unsupported" } as const;
          return installed
            ? ({ state: "pass", code: "factory-installed" } as const)
            : ({ state: "fail", code: "factory-replaced" } as const);
        })
        .catch(() => unexpected);
      const [machines, fleet, sockets] = await Promise.all([
        deps
          .fetchMachines()
          .then(hubCheck)
          .catch(() => unexpected),
        deps
          .fetchFleet()
          .then(hubCheck)
          .catch(() => unexpected),
        Promise.all(
          targets.map((target) => {
            const existing = checks.get(target.environmentId);
            if (existing) return existing;
            const check = deps.openSocket(target, signal).catch(() => unexpected);
            checks.set(target.environmentId, check);
            return check;
          }),
        ),
      ]);
      // A socket can trigger a probe or fall back, so read the path after the opens settle.
      const [paired, log] = await Promise.all([
        Promise.all(
          targets.map(async (target, index): Promise<MachineDiagnostics> => ({
            ...target,
            socket: sockets[index] ?? unexpected,
            direct: await deps.readDirect(target.origin).catch(() => null),
          })),
        ),
        deps.readLog().catch(() => []),
      ]);
      return { at: Date.now(), transport, machines, fleet, paired, log };
    },

    async test(
      origin: string,
    ): Promise<Pick<MachineDiagnostics, "direct" | "test"> & { log: MeshDiagnostics["log"] }> {
      const test = await deps
        .probe(origin)
        .then((result): DiagnosticCheck => {
          if (result === "ok") return { state: "pass", code: result };
          if (result === null) return { state: "skipped", code: "unsupported" };
          return { state: PROBE_FAILURES.includes(result) ? "fail" : "skipped", code: result };
        })
        .catch(() => unexpected);
      const [direct, log] = await Promise.all([
        deps.readDirect(origin).catch(() => null),
        deps.readLog().catch(() => []),
      ]);
      return { direct, test, log };
    },
  };
}

export function openDiagnosticWebSocket(
  url: string,
  signal: AbortSignal,
): Promise<DiagnosticCheck> {
  const cancelled: DiagnosticCheck = { state: "skipped", code: "cancelled" };
  if (signal.aborted) return Promise.resolve(cancelled);
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const finish = (check: DiagnosticCheck) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve(check);
    };
    const abort = () => finish(cancelled);
    const failed = () => finish({ state: "fail", code: "socket-failed" });
    const timeout = setTimeout(() => finish({ state: "fail", code: "socket-timeout" }), 12_000);
    signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("error", failed, { once: true });
    socket.addEventListener("close", failed, { once: true });
    socket.addEventListener(
      "open",
      () => {
        // RN Android only registers the socket on open, so this also closes late upgrades.
        socket.close();
        finish({ state: "pass", code: "socket-opened" });
      },
      { once: true },
    );
  });
}
