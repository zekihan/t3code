import { useEffect, useRef, useState } from "react";

import { chooseClientCertificate, clientCertificatesAvailable } from "../../lib/clientCertificates";
import { fetchMeshMachines, type MeshFetchResult } from "./meshHub";
import { nativeMeshAliasApi, syncMeshAliases } from "./meshAliases";
import type { MeshMachine } from "./meshMachines";
import { loadCachedMeshMachines, saveCachedMeshMachines } from "./meshStore";
import { MESH_HUB_URL } from "./meshViewerUrl";
import { useClientCertificateStatus } from "./useClientCertificateStatus";

export type MeshProblem =
  | { readonly kind: "no-certificate"; readonly message: string | null }
  | { readonly kind: "refused"; readonly status: number }
  | { readonly kind: "unavailable"; readonly message: string };

export interface MeshState {
  /** The hub's latest list, or the saved one until the hub answers; null when there is none. */
  readonly machines: readonly MeshMachine[] | null;
  readonly fromCache: boolean;
  readonly problem: MeshProblem | null;
  readonly loading: boolean;
  /** When the list was last checked, for "seen 5m ago" labels. */
  readonly now: number;
}

const initialState = (): MeshState => ({
  machines: null,
  fromCache: false,
  problem: null,
  loading: true,
  now: Date.now(),
});

function problemOf(result: Exclude<MeshFetchResult, { kind: "ok" }>): MeshProblem {
  return result.kind === "no-certificate" ? { kind: "no-certificate", message: null } : result;
}

/**
 * The Mesh screen's data. The first open with no hub certificate shows the KeyChain picker; the
 * list is fetched again whenever the hub's alias changes, and a list the hub returns also hands
 * the hub's identity to those machines' viewer hosts (see `syncMeshAliases`).
 */
export function useMeshMachines() {
  const { alias, status } = useClientCertificateStatus(MESH_HUB_URL);
  const [state, setState] = useState<MeshState>(initialState);
  const request = useRef(0);
  const prompted = useRef(false);

  const refresh = async (promptForCertificate: boolean) => {
    const id = ++request.current;
    const current = () => id === request.current;
    setState((previous) => ({ ...previous, loading: true }));
    let pickerMessage: string | null = null;
    if (alias === null && promptForCertificate && clientCertificatesAvailable) {
      try {
        await chooseClientCertificate(MESH_HUB_URL);
      } catch (error) {
        pickerMessage = error instanceof Error ? error.message : "Could not select a certificate.";
      }
    }
    const result = await fetchMeshMachines();
    if (!current()) return;
    if (result.kind === "ok") {
      setState({
        machines: result.machines,
        fromCache: false,
        problem: null,
        loading: false,
        now: Date.now(),
      });
      void saveCachedMeshMachines(result.machines);
      // Only a list the hub just returned may move aliases; failures leave the old ones as they are.
      await syncMeshAliases(nativeMeshAliasApi, result.machines).catch(() => undefined);
      return;
    }
    const problem = problemOf(result);
    setState((previous) => ({
      ...previous,
      problem:
        problem.kind === "no-certificate"
          ? { kind: "no-certificate", message: pickerMessage }
          : problem,
      loading: false,
      now: Date.now(),
    }));
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the list lives on the hub; the effect fetches it on open and when the hub's certificate changes
  useEffect(() => {
    let live = true;
    void loadCachedMeshMachines().then((cached) => {
      if (live && cached) {
        setState((previous) =>
          previous.machines === null
            ? { ...previous, machines: cached, fromCache: true }
            : previous,
        );
      }
    });
    return () => {
      live = false;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the list lives on the hub; the effect fetches it on open and whenever the hub's certificate changes
  useEffect(() => {
    const first = !prompted.current;
    prompted.current = true;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refetch only when the hub's alias changes, not on each render's new refresh closure
    void refresh(first);
  }, [alias]);

  return {
    state,
    alias,
    status,
    refresh: () => refresh(false),
    chooseCertificate: () =>
      chooseClientCertificate(MESH_HUB_URL).then(
        () => undefined,
        (error: unknown) =>
          setState((previous) => ({
            ...previous,
            problem: {
              kind: "no-certificate",
              message: error instanceof Error ? error.message : "Could not select a certificate.",
            },
          })),
      ),
  };
}
