import { requireOptionalNativeModule } from "expo";

import type {
  ClientCertificateIdentityProblem,
  ClientCertificateStatus,
  ClientCertificateSubscription as Subscription,
  ClientCertificateTransferInput,
} from "./clientCertificates.types";

interface CertificateModule {
  getAlias(url: string): string | null;
  getCertificateInfo(url: string): Promise<ClientCertificateStatus | null>;
  choose(url: string): Promise<string | null>;
  remove(url: string): Promise<void>;
  assignMeshAlias(url: string, alias: string): Promise<boolean>;
  releaseMeshAlias(url: string): Promise<boolean>;
  getMeshAliasOrigins(): string[];
  createTransfer(url: string): string;
  transfer(
    id: string,
    fileUri: string,
    upload: boolean,
    contentType: string,
  ): Promise<{ status: number }>;
  cancel(id: string): void;
  addListener(
    name: "transferProgress",
    listener: (event: { id: string; bytesSent: number; totalBytes: number }) => void,
  ): Subscription;
  addListener(name: "changed", listener: (event: { origin: string }) => void): Subscription;
  addListener(
    name: "identityProblem",
    listener: (event: ClientCertificateIdentityProblem) => void,
  ): Subscription;
}

// Android installs the transport in MainApplication before Expo/React Native create clients.
// Preferences are read natively, so cold-start reconnect does not race JS hydration.
const native = requireOptionalNativeModule<CertificateModule>("T3ClientCertificates");

export const clientCertificatesAvailable = native !== null;
export const selectedClientCertificate = (url: string): string | null =>
  native?.getAlias(url) ?? null;
export const onClientCertificateChange = (listener: () => void): Subscription =>
  native?.addListener("changed", listener) ?? { remove() {} };
/** Resolves null when no certificate is selected for the destination. */
export const clientCertificateStatus = (url: string): Promise<ClientCertificateStatus | null> =>
  native ? native.getCertificateInfo(url) : Promise.resolve(null);
/** Fires when a stored alias cannot be used, e.g. after the certificate was renewed or removed. */
export const onClientCertificateIdentityProblem = (
  listener: (problem: ClientCertificateIdentityProblem) => void,
): Subscription => native?.addListener("identityProblem", listener) ?? { remove() {} };
export const chooseClientCertificate = (url: string): Promise<string | null> => {
  if (!native)
    return Promise.reject(new Error("Client certificates require the Android custom build."));
  return native.choose(url);
};
export const removeClientCertificate = (url: string): Promise<void> => {
  if (!native)
    return Promise.reject(new Error("Client certificates require the Android custom build."));
  return native.remove(url);
};
/** Gives `url`'s origin `alias` unless it has an alias the person chose. False when it has one. */
export const assignMeshClientCertificate = (url: string, alias: string): Promise<boolean> => {
  if (!native)
    return Promise.reject(new Error("Client certificates require the Android custom build."));
  return native.assignMeshAlias(url, alias);
};
/** Removes the alias the Mesh screen assigned to `url`'s origin; true when one was removed. */
export const releaseMeshClientCertificate = (url: string): Promise<boolean> => {
  if (!native)
    return Promise.reject(new Error("Client certificates require the Android custom build."));
  return native.releaseMeshAlias(url);
};
/** Origins whose alias the Mesh screen assigned. */
export const meshClientCertificateOrigins = (): readonly string[] =>
  native?.getMeshAliasOrigins() ?? [];

/** Returns null for ordinary destinations; callers retain their existing Expo transfer path. */
export async function transferWithClientCertificate(
  input: ClientCertificateTransferInput,
): Promise<{ status: number } | null> {
  if (!native || !selectedClientCertificate(input.url)) return null;
  if (input.signal.aborted) throw new Error("Transfer cancelled.");
  const id = native.createTransfer(input.url);
  const cancel = () => native.cancel(id);
  let subscription: Subscription | null = null;
  try {
    subscription = input.onProgress
      ? native.addListener("transferProgress", (event) => {
          if (event.id === id && event.totalBytes > 0)
            input.onProgress?.(event.bytesSent / event.totalBytes);
        })
      : null;
    input.signal.addEventListener("abort", cancel, { once: true });
    if (input.signal.aborted) throw new Error("Transfer cancelled.");
    const result = await native.transfer(
      id,
      input.fileUri,
      input.upload ?? false,
      input.contentType ?? "application/octet-stream",
    );
    if (input.signal.aborted) throw new Error("Transfer cancelled.");
    return result;
  } finally {
    input.signal.removeEventListener("abort", cancel);
    native.cancel(id);
    subscription?.remove();
  }
}
