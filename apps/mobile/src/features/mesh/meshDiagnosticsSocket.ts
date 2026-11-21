import {
  ConnectionResolver,
  connectionRouteId,
  connectionRoutes,
  routeEntry,
  routeHttpBaseUrl,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AtomRegistry } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";
import {
  getDirectDecisionLog,
  getDirectDiagnostics,
  isProviderFactoryInstalled,
  testDirectPath,
} from "./meshDirect";
import {
  createMeshDiagnosticsRunner,
  openDiagnosticWebSocket,
  type DiagnosticCheck,
  type DiagnosticTarget,
} from "./meshDiagnostics";
import { fetchMeshFleet, fetchMeshMachines } from "./meshHub";
import { meshViewerOriginOf } from "./meshViewerUrl";

export function pairedMeshDiagnosticTargets(): readonly DiagnosticTarget[] {
  const targets = new Map<string, DiagnosticTarget>();
  for (const [environmentId, entry] of appAtomRegistry.get(environmentCatalog.catalogValueAtom)
    .entries) {
    for (const route of connectionRoutes(entry)) {
      const origin = meshViewerOriginOf(routeHttpBaseUrl(route) ?? "");
      if (origin !== null && new URL(origin).port === "") {
        targets.set(`${environmentId}:${origin}`, { environmentId, origin });
      }
    }
  }
  return [...targets.values()];
}

async function openSocket(
  { environmentId, origin }: { environmentId: EnvironmentId; origin: string },
  signal: AbortSignal,
): Promise<DiagnosticCheck> {
  const entry = appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(environmentId);
  if (!entry) return { state: "skipped", code: "no-socket-route" };
  const routes = connectionRoutes(entry);
  const prepared = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  const activeRoute = prepared
    ? routes.find(({ target }) => connectionRouteId(target) === connectionRouteId(prepared.target))
    : undefined;
  const route =
    activeRoute ??
    routes.find((candidate) => meshViewerOriginOf(routeHttpBaseUrl(candidate) ?? "") === origin);
  if (!route) return { state: "skipped", code: "no-socket-route" };
  const selected = routeEntry(entry, route);
  const fresh = await Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) =>
        Effect.gen(function* () {
          const resolver = yield* ConnectionResolver;
          return yield* resolver.prepare(selected);
        }).pipe(Effect.provide(context)),
      ),
      Effect.timeout("12 seconds"),
    ),
    { signal },
  ).catch(() => null);
  if (signal.aborted) return { state: "skipped", code: "cancelled" };
  if (!fresh) return { state: "fail", code: "socket-prepare-failed" };
  return openDiagnosticWebSocket(fresh.socketUrl, signal);
}

export const meshDiagnosticsRunner = createMeshDiagnosticsRunner({
  factoryInstalled: isProviderFactoryInstalled,
  fetchMachines: fetchMeshMachines,
  fetchFleet: fetchMeshFleet,
  readDirect: getDirectDiagnostics,
  readLog: getDirectDecisionLog,
  probe: testDirectPath,
  openSocket,
});
