import { certificateMediaExtension, loadCertificateMedia } from "../../lib/certificateMedia";
import { selectedClientCertificate } from "../../lib/clientCertificates";

const MAX_LEASES = 32;
type Lease = { readonly uri: string; dispose(): void };
const leases = new Map<string, Promise<Lease>>();

/**
 * The enriched markdown view draws inline images with a private OkHttp client that cannot present
 * the certificate. Protected URLs become private files; only the newest are kept.
 */
export async function nativeMarkdownImageUri(uri: string): Promise<string> {
  if (selectedClientCertificate(uri) === null) return uri;
  let lease = leases.get(uri);
  if (!lease) {
    const created = loadCertificateMedia(uri, new AbortController().signal, {
      extension: certificateMediaExtension(uri),
    });
    lease = created;
    leases.set(uri, created);
    created.catch(() => {
      if (leases.get(uri) === created) leases.delete(uri);
    });
    for (const [key, old] of leases) {
      if (leases.size <= MAX_LEASES) break;
      leases.delete(key);
      old.then(
        (media) => media.dispose(),
        () => {},
      );
    }
  }
  return (await lease).uri;
}
