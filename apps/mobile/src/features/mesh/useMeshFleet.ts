import { useEffect, useEffectEvent, useRef, useState } from "react";

import { chooseClientCertificate } from "../../lib/clientCertificates";
import type { MeshFleet, MeshHubRequest } from "./meshFleet";
import { fetchMeshFleet } from "./meshHub";
import { watchFleetRefreshTriggers } from "./meshNetwork";
import { MESH_HUB_URL } from "./meshViewerUrl";
import type { MeshProblem } from "./useMeshMachines";
import { useClientCertificateStatus } from "./useClientCertificateStatus";

export interface MeshFleetState {
  /** The hub's latest answer, kept while a refresh runs or fails; null until there is one. */
  readonly fleet: MeshFleet | null;
  /** The request that produced `fleet`: its path and round-trip time. */
  readonly request: MeshHubRequest | null;
  readonly problem: MeshProblem | null;
  readonly loading: boolean;
  /** When the fleet was last checked, for "up 3h" and "expires in 12 days" labels. */
  readonly now: number;
}

const initialState = (): MeshFleetState => ({
  fleet: null,
  request: null,
  problem: null,
  loading: true,
  now: Date.now(),
});

/**
 * The fleet status and the phone's hub-request path and round-trip time. It is fetched when
 * `focused` becomes true, when the hub's certificate changes, and again whenever the network
 * changes or the app returns to the front while focused, so a network change updates the path.
 * The newest request wins: an answer that arrives after a newer one started is dropped.
 */
export function useMeshFleet(options: { readonly focused: boolean }) {
  const { alias, status } = useClientCertificateStatus(MESH_HUB_URL);
  const [state, setState] = useState<MeshFleetState>(initialState);
  const request = useRef(0);

  const refresh = async () => {
    const id = ++request.current;
    setState((previous) => ({ ...previous, loading: true }));
    const result = await fetchMeshFleet();
    if (id !== request.current) return;
    if (result.kind === "ok") {
      setState({
        fleet: result.fleet,
        request: { path: result.fleet.callerPath, rttMs: result.rttMs },
        problem: null,
        loading: false,
        now: Date.now(),
      });
      return;
    }
    setState((previous) => ({
      ...previous,
      problem:
        result.kind === "no-certificate" ? { kind: "no-certificate", message: null } : result,
      loading: false,
      now: Date.now(),
    }));
  };
  const refreshOnTrigger = useEffectEvent(() => void refresh());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the fleet lives on the hub; the effect fetches it when the screen is focused and when the hub's certificate changes
  useEffect(() => {
    if (!options.focused) return;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies, react/set-state-in-effect -- refetch only on focus or alias changes, not on each render's new refresh closure; the loading flag is set as the fetch of the hub's data begins
    void refresh();
  }, [alias, options.focused]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the hub-request path is a property of the phone's current network, which only the OS reports
  useEffect(() => {
    if (!options.focused) return undefined;
    return watchFleetRefreshTriggers(refreshOnTrigger);
  }, [options.focused]);

  return {
    state,
    alias,
    status,
    refresh,
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
