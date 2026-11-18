import {
  clientCertificatesAvailable,
  selectedClientCertificate,
} from "../../lib/clientCertificates";
import { parseMeshFleet, type MeshFleet } from "./meshFleet";
import { parseMeshMachines, type MeshMachine } from "./meshMachines";
import { MESH_FLEET_URL, MESH_HUB_URL, MESH_MACHINES_URL } from "./meshViewerUrl";

export const MESH_FETCH_TIMEOUT_MS = 10_000;

export type MeshFetchResult =
  | { readonly kind: "ok"; readonly machines: readonly MeshMachine[] }
  /** No certificate is selected for the hub, so no request was made. */
  | { readonly kind: "no-certificate" }
  /** The hub answered 401 or 403: it does not admit this identity. */
  | { readonly kind: "refused"; readonly status: number }
  /** The hub could not be reached or did not answer with a machine list. */
  | { readonly kind: "unavailable"; readonly message: string };

export interface MeshFetchDeps {
  readonly fetch?: typeof fetch;
  readonly hasCertificate?: () => boolean;
  readonly timeoutMs?: number;
  /** A monotonic clock in milliseconds; `performance.now` by default. */
  readonly now?: () => number;
}

type HubFailure = Exclude<MeshFetchResult, { kind: "ok" }>;

/**
 * One GET to the hub through the app's client-certificate transport, which presents the alias
 * selected for the hub's origin. `rttMs` is the time until the response headers arrived: the
 * clock stops before the body is read and parsed.
 */
async function getFromHub<T>(
  url: string,
  parse: (payload: unknown) => T | null,
  notAnAnswer: string,
  deps: MeshFetchDeps,
): Promise<{ readonly kind: "ok"; readonly value: T; readonly rttMs: number } | HubFailure> {
  const hasCertificate =
    deps.hasCertificate ??
    (() => clientCertificatesAvailable && selectedClientCertificate(MESH_HUB_URL) !== null);
  if (!hasCertificate()) return { kind: "no-certificate" };
  const now = deps.now ?? (() => performance.now());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? MESH_FETCH_TIMEOUT_MS);
  try {
    const startedAt = now();
    const response = await (deps.fetch ?? fetch)(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const rttMs = Math.max(0, Math.round(now() - startedAt));
    if (response.status === 401 || response.status === 403) {
      return { kind: "refused", status: response.status };
    }
    if (!response.ok) {
      return { kind: "unavailable", message: `The hub answered HTTP ${response.status}.` };
    }
    const value = parse(await response.json());
    return value === null
      ? { kind: "unavailable", message: notAnAnswer }
      : { kind: "ok", value, rttMs };
  } catch (error) {
    return {
      kind: "unavailable",
      message: controller.signal.aborted
        ? "The hub did not answer in time."
        : error instanceof Error && error.message
          ? error.message
          : "Could not reach the hub.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Asks the hub for the caller's machines. */
export async function fetchMeshMachines(deps: MeshFetchDeps = {}): Promise<MeshFetchResult> {
  const result = await getFromHub(
    MESH_MACHINES_URL,
    parseMeshMachines,
    "The hub's answer was not a machine list.",
    deps,
  );
  return result.kind === "ok" ? { kind: "ok", machines: result.value } : result;
}

export type MeshFleetFetchResult =
  | {
      readonly kind: "ok";
      readonly fleet: MeshFleet;
      /** Request-to-headers time of this same request, in milliseconds. */
      readonly rttMs: number;
    }
  | Exclude<MeshFetchResult, { kind: "ok" }>;

/**
 * Asks the hub for the fleet status. The hub classifies this request's path (`caller.path`) and
 * the app times it, so the path and the round-trip time describe the same request.
 */
export async function fetchMeshFleet(deps: MeshFetchDeps = {}): Promise<MeshFleetFetchResult> {
  const result = await getFromHub(
    MESH_FLEET_URL,
    parseMeshFleet,
    "The hub's answer was not a fleet status.",
    deps,
  );
  return result.kind === "ok" ? { kind: "ok", fleet: result.value, rttMs: result.rttMs } : result;
}
