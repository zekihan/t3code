import { useEffect, useState } from "react";

import * as directApi from "./meshDirect";
import type { DirectChangedEvent, DirectStatus } from "./meshDirect.types";

export interface MeshDirectApi {
  readonly getStatus: (url: string) => Promise<DirectStatus | null>;
  readonly onChanged: (listener: (event: DirectChangedEvent) => void) => { remove(): void };
}

const nativeDirectApi: MeshDirectApi = {
  getStatus: directApi.getDirectStatus,
  onChanged: directApi.onDirectChanged,
};

/**
 * The direct-connection status of the environment at `origin`, kept current: read once, and
 * again whenever the native layer says that machine's path or its reason changed. Null until read,
 * on other platforms and for an origin that is not a mesh viewer host.
 */
export function useMeshDirect(
  origin: string,
  api: MeshDirectApi = nativeDirectApi,
): DirectStatus | null {
  const [status, setStatus] = useState<DirectStatus | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the path is decided natively; the effect mirrors it and listens for changes
  useEffect(() => {
    let live = true;
    const read = () =>
      api.getStatus(origin).then(
        (next) => {
          if (live) setStatus(next);
        },
        () => undefined,
      );
    void read();
    const subscription = api.onChanged((event) => {
      if (event.origin === origin) void read();
    });
    return () => {
      live = false;
      subscription.remove();
    };
  }, [api, origin]);

  return status;
}
