import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";

import { removeClientCertificate, selectedClientCertificate } from "./clientCertificates";

interface EnvironmentWithUrl {
  readonly environmentId: string;
  readonly displayUrl: string;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Forgets the certificate choice of a removed environment unless another one shares its origin. */
export async function removeEnvironmentKeepingCertificates(
  environments: ReadonlyArray<EnvironmentWithUrl>,
  environmentId: string,
  remove: () => Promise<AtomCommandResult<unknown, unknown>>,
) {
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const result = await remove();
  if (!AsyncResult.isSuccess(result) || !environment) return result;
  if (!selectedClientCertificate(environment.displayUrl)) return result;
  const origin = originOf(environment.displayUrl);
  const shared = environments.some(
    (entry) => entry.environmentId !== environmentId && originOf(entry.displayUrl) === origin,
  );
  if (!shared) await removeClientCertificate(environment.displayUrl);
  return result;
}
