import { useEffect, useState, useSyncExternalStore } from "react";

import {
  clientCertificateStatus,
  onClientCertificateChange,
  selectedClientCertificate,
} from "../../lib/clientCertificates";
import type { ClientCertificateStatus } from "../../lib/clientCertificates.types";

function subscribe(listener: () => void) {
  const subscription = onClientCertificateChange(listener);
  return () => subscription.remove();
}

/**
 * The alias selected for `endpoint` and what KeyChain says about it. The status is read again
 * when the selection changes or `refreshKey` does, since KeyChain can drop the app's access to
 * an alias without the alias itself changing.
 */
export function useClientCertificateStatus(endpoint: string, refreshKey?: unknown) {
  const alias = useSyncExternalStore(
    subscribe,
    () => selectedClientCertificate(endpoint),
    () => null,
  );
  const [status, setStatus] = useState<ClientCertificateStatus | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the expiry comes from KeyChain, which only the native module can read; a replaced certificate keeps its alias
  useEffect(() => {
    let current = true;
    const refresh = () => {
      if (!alias) {
        setStatus(null);
        return;
      }
      clientCertificateStatus(endpoint).then(
        (next) => current && setStatus(next),
        () => current && setStatus(null),
      );
    };
    refresh();
    const subscription = onClientCertificateChange(refresh);
    return () => {
      current = false;
      subscription.remove();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refreshKey only re-runs the lookup
  }, [alias, endpoint, refreshKey]);
  return { alias, status };
}
