import {
  clientCertificatesAvailable,
  selectedClientCertificate,
} from "../../lib/clientCertificates";
import { parseMeshMachines, type MeshMachine } from "./meshMachines";
import { MESH_HUB_URL, MESH_MACHINES_URL } from "./meshViewerUrl";

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
}

/**
 * Asks the hub for the caller's machines. The request goes through the app's client-certificate
 * transport like every other request, which presents the alias selected for the hub's origin.
 */
export async function fetchMeshMachines(deps: MeshFetchDeps = {}): Promise<MeshFetchResult> {
  const hasCertificate =
    deps.hasCertificate ??
    (() => clientCertificatesAvailable && selectedClientCertificate(MESH_HUB_URL) !== null);
  if (!hasCertificate()) return { kind: "no-certificate" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? MESH_FETCH_TIMEOUT_MS);
  try {
    const response = await (deps.fetch ?? fetch)(MESH_MACHINES_URL, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { kind: "refused", status: response.status };
    }
    if (!response.ok) {
      return { kind: "unavailable", message: `The hub answered HTTP ${response.status}.` };
    }
    const machines = parseMeshMachines(await response.json());
    return machines === null
      ? { kind: "unavailable", message: "The hub's answer was not a machine list." }
      : { kind: "ok", machines };
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
