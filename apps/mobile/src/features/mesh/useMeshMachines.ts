import { msg } from "gt-react-native";
import { useEffect, useRef, useState } from "react";

import { m } from "../../i18n/messages";
import {
  chooseClientCertificate,
  clientCertificatesAvailable,
  selectedClientCertificate,
} from "../../lib/clientCertificates";
import { fetchMeshMachines } from "./meshHub";
import { nativeMeshAliasApi, syncMeshAliases } from "./meshAliases";
import { setMeshOrigins } from "./meshEnrollment";
import { isEnrolledAlias } from "./meshEnrollmentLogic";
import type { MeshMachine } from "./meshMachines";
import { loadCachedMeshMachines, saveCachedMeshMachines } from "./meshStore";
import { MESH_HUB_URL } from "./meshViewerUrl";
import { useClientCertificateStatus } from "./useClientCertificateStatus";

export type MeshProblem =
  | { readonly kind: "no-certificate"; readonly message: string | null }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly credential?: { readonly alias: string; readonly startedAt: number };
    }
  | { readonly kind: "unavailable"; readonly message: string };

export interface MeshState {
  /** The hub's latest list, or the saved one until the hub answers; null when there is none. */
  readonly machines: readonly MeshMachine[] | null;
  readonly fromCache: boolean;
  readonly problem: MeshProblem | null;
  readonly loading: boolean;
  /** When the hub returned the displayed list; null for legacy cache entries. */
  readonly checkedAt: number | null;
  /** Reference time for relative labels. */
  readonly now: number;
}

const initialState = (): MeshState => ({
  machines: null,
  fromCache: false,
  problem: null,
  loading: true,
  now: Date.now(),
  checkedAt: null,
});

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
    setState((previous) => ({ ...previous, loading: true, now: Date.now() }));
    let pickerMessage: string | null = null;
    if (alias === null && promptForCertificate && clientCertificatesAvailable) {
      try {
        await chooseClientCertificate(MESH_HUB_URL);
      } catch (error) {
        pickerMessage =
          error instanceof Error ? error.message : m(msg("Could not select a certificate."));
      }
    }
    const requestedAlias = selectedClientCertificate(MESH_HUB_URL);
    const startedAt = Date.now();
    const result = await fetchMeshMachines();
    if (!current()) return;
    if (result.kind === "ok") {
      const checkedAt = Date.now();
      setState({
        machines: result.machines,
        fromCache: false,
        problem: null,
        loading: false,
        now: checkedAt,
        checkedAt,
      });
      void saveCachedMeshMachines(result.machines, checkedAt);
      // The enrolled identity applies to the origins the hub just listed, and to no others.
      void setMeshOrigins(result.machines.map((machine) => machine.viewerOrigin)).catch(
        () => undefined,
      );
      // Only a list the hub just returned may move aliases; failures leave the old ones as they are.
      await syncMeshAliases(nativeMeshAliasApi, result.machines).catch(() => undefined);
      return;
    }
    let problem: MeshProblem =
      result.kind === "no-certificate"
        ? { kind: "no-certificate", message: pickerMessage }
        : result;
    if (result.kind === "refused" && requestedAlias && isEnrolledAlias(requestedAlias)) {
      problem = { ...result, credential: { alias: requestedAlias, startedAt } };
    }
    setState((previous) => ({
      ...previous,
      problem,
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
          previous.machines === null ? { ...previous, ...cached, fromCache: true } : previous,
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
              message:
                error instanceof Error ? error.message : m(msg("Could not select a certificate.")),
            },
          })),
      ),
  };
}
