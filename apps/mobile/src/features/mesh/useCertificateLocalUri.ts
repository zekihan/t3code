import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { certificateMediaExtension, loadCertificateMedia } from "../../lib/certificateMedia";
import { onClientCertificateChange, selectedClientCertificate } from "../../lib/clientCertificates";

function subscribe(listener: () => void) {
  const subscription = onClientCertificateChange(listener);
  return () => subscription.remove();
}

/** True when the URL's origin has a selected client certificate; always false off Android. */
export function useHasClientCertificate(uri: string | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => uri !== null && selectedClientCertificate(uri) !== null,
    () => false,
  );
}

export type CertificateLocalUri =
  | { readonly state: "loading"; readonly uri: null; readonly local: boolean }
  | { readonly state: "failed"; readonly uri: null; readonly local: boolean }
  | { readonly state: "ready"; readonly uri: string | null; readonly local: boolean };

type Settled = { readonly source: string; readonly uri: string | null };

/**
 * WebViews cannot present the client certificate. A URL whose origin has one is downloaded through
 * the certificate transport into an app-owned file that the WebView loads instead; any other URL
 * is returned unchanged. The file is deleted when the URL changes or the component unmounts.
 */
export function useCertificateLocalUri(
  uri: string | null,
  fallbackExtension = ".html",
): CertificateLocalUri {
  const protectedUri = useHasClientCertificate(uri);
  const [settled, setSettled] = useState<Settled | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the certificate transport is native; the lease it returns must be released when the URL changes or the view unmounts
  useEffect(() => {
    if (uri === null || !protectedUri) return;
    const controller = new AbortController();
    let lease: { dispose(): void } | null = null;
    loadCertificateMedia(uri, controller.signal, {
      extension: certificateMediaExtension(uri, fallbackExtension),
    }).then(
      (media) => {
        if (controller.signal.aborted) media.dispose();
        else {
          lease = media;
          setSettled({ source: uri, uri: media.uri });
        }
      },
      () => {
        if (!controller.signal.aborted) setSettled({ source: uri, uri: null });
      },
    );
    return () => {
      controller.abort();
      lease?.dispose();
    };
  }, [uri, protectedUri, fallbackExtension]);
  if (uri === null || !protectedUri) return { state: "ready", uri, local: false };
  if (settled?.source !== uri) return { state: "loading", uri: null, local: true };
  return settled.uri === null
    ? { state: "failed", uri: null, local: true }
    : { state: "ready", uri: settled.uri, local: true };
}

/**
 * Props for a WebView showing a leased local page. Android blocks file URLs unless allowed, and
 * allowFileAccessFromFileURLs stays off so the page cannot read other files.
 */
export function certificateWebViewProps(local: CertificateLocalUri): {
  readonly allowFileAccess?: boolean;
  readonly originWhitelist?: string[];
} {
  return local.local ? { allowFileAccess: true, originWhitelist: ["*"] } : {};
}

/** A leased page may not navigate to any other file URL, such as the app's private storage. */
export function certificateNavigationAllowed(local: CertificateLocalUri, url: string) {
  if (!local.local || !/^file:/i.test(url)) return true;
  return local.uri !== null && url.split("#", 1)[0] === local.uri.split("#", 1)[0];
}

/**
 * Leases protected audio or other native-player media. Each call replaces the previous lease; the
 * latest is deleted on unmount. Unprotected URLs are returned unchanged.
 */
export function useCertificateMediaLease() {
  const current = useRef<{ dispose(): void } | null>(null);
  const controller = useRef<AbortController | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the native file lease when the view unmounts
  useEffect(
    () => () => {
      controller.current?.abort();
      current.current?.dispose();
      current.current = null;
    },
    [],
  );
  return async (uri: string): Promise<string> => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const media = await loadCertificateMedia(uri, request.signal);
    if (request.signal.aborted) {
      media.dispose();
      throw new Error("Media download cancelled.");
    }
    const previous = current.current;
    current.current = media;
    previous?.dispose();
    return media.uri;
  };
}
