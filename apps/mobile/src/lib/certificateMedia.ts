import { msg } from "gt-react-native";

import { m } from "../i18n/messages";
import { selectedClientCertificate, transferWithClientCertificate } from "./clientCertificates";

/**
 * Expo Video and Expo Audio bypass React Native's TLS hooks, so protected media needs a private
 * file lease. WebViews also cannot present the certificate, so protected pages are leased too and
 * pass an extension, which is how a WebView picks the type of a local file.
 */
export async function loadCertificateMedia(
  uri: string,
  signal: AbortSignal,
  options: { readonly extension?: string } = {},
): Promise<{ uri: string; dispose(): void }> {
  if (!selectedClientCertificate(uri)) return { uri, dispose() {} };
  if (signal.aborted) throw new Error(m(msg("Media download cancelled.")));
  const [{ File, Paths }, { uuidv4 }] = await Promise.all([
    import("expo-file-system"),
    import("./uuid"),
  ]);
  const file = new File(Paths.cache, `t3-mtls-media-${uuidv4()}${options.extension ?? ""}`);
  const dispose = () => {
    if (file.exists) file.delete();
  };
  try {
    const result = await transferWithClientCertificate({ url: uri, fileUri: file.uri, signal });
    if (result === null) throw new Error(m(msg("Certificate selection changed. Try again.")));
    if (signal.aborted) throw new Error(m(msg("Media download cancelled.")));
    return { uri: file.uri, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** The extension of the URL's path, which a WebView uses to type a local file. */
export function certificateMediaExtension(uri: string, fallback = ""): string {
  try {
    return /\.[a-z0-9]{1,8}$/i.exec(new URL(uri).pathname)?.[0] ?? fallback;
  } catch {
    return fallback;
  }
}
