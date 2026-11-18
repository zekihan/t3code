import {
  assignMeshClientCertificate,
  meshClientCertificateOrigins,
  releaseMeshClientCertificate,
  selectedClientCertificate,
} from "../../lib/clientCertificates";
import { isEnrolledAlias } from "./meshEnrollmentLogic";
import type { MeshMachine } from "./meshMachines";
import { MESH_HUB_URL } from "./meshViewerUrl";

export interface MeshAliasApi {
  readonly hubAlias: () => string | null;
  /** False when the origin keeps an alias the person chose. */
  readonly assign: (origin: string, alias: string) => Promise<boolean>;
  readonly release: (origin: string) => Promise<boolean>;
  readonly assigned: () => readonly string[];
}

export const nativeMeshAliasApi: MeshAliasApi = {
  hubAlias: () => selectedClientCertificate(MESH_HUB_URL),
  assign: assignMeshClientCertificate,
  release: releaseMeshClientCertificate,
  assigned: meshClientCertificateOrigins,
};

export interface MeshAliasSync {
  /** Viewer origins that now use the hub's alias because the app assigned it. */
  readonly assigned: readonly string[];
  /** Viewer origins that keep an alias the person chose. */
  readonly keptOwn: readonly string[];
  /** Origins whose app-assigned alias was removed because the machine is no longer listed. */
  readonly released: readonly string[];
  readonly failed: readonly string[];
}

const withoutSlash = (origin: string) => origin.replace(/\/$/, "");

/**
 * Makes the hub's KeyChain identity the viewer hosts' identity, for the machines in a list the hub
 * just returned: an origin with no alias gets it, a chosen alias stays, and an assigned one goes
 * when its machine is no longer listed. An enrolled identity is no alias: the transport applies
 * it to every listed origin itself (`setMeshOrigins`).
 */
export async function syncMeshAliases(
  api: MeshAliasApi,
  machines: readonly MeshMachine[],
): Promise<MeshAliasSync> {
  const result = {
    assigned: [] as string[],
    keptOwn: [] as string[],
    released: [] as string[],
    failed: [] as string[],
  };
  const hubAlias = api.hubAlias();
  if (hubAlias === null || isEnrolledAlias(hubAlias)) return result;
  const listed = new Set(machines.map((machine) => machine.viewerOrigin));
  for (const origin of listed) {
    try {
      ((await api.assign(origin, hubAlias)) ? result.assigned : result.keptOwn).push(origin);
    } catch {
      result.failed.push(origin);
    }
  }
  for (const marked of api.assigned()) {
    const origin = withoutSlash(marked);
    if (listed.has(origin)) continue;
    try {
      if (await api.release(origin)) result.released.push(origin);
    } catch {
      result.failed.push(origin);
    }
  }
  return result;
}
