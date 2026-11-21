import { fetch } from "expo/fetch";
import type { SharePayload } from "expo-sharing";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";
import {
  clientCertificatesAvailable,
  selectedClientCertificate,
} from "../../lib/clientCertificates";
import { MESH_FETCH_TIMEOUT_MS } from "./meshHub";
import { meshViewerOriginOf } from "./meshViewerUrl";

function parseMeshThreadUrl(value: string) {
  try {
    const url = new URL(value);
    const origin = meshViewerOriginOf(url.href);
    if (origin === null || url.username || url.password) return null;
    const segments = url.pathname.replace(/\/$/, "").slice(1).split("/");
    const ids = segments.length === 3 && segments[0] === "threads" ? segments.slice(1) : segments;
    if (ids.length !== 2) return null;
    const environmentId = decodeURIComponent(ids[0]!).trim();
    const threadId = decodeURIComponent(ids[1]!).trim();
    if (!environmentId || !threadId) return null;
    url.hash = "";
    return { url, origin, target: { environmentId, threadId } };
  } catch {
    return null;
  }
}

function certificateError(cause?: unknown): Error {
  return new Error(
    m(
      msg(
        "This mesh link needs this device's client certificate. Check device enrollment in Mesh or select the certificate in the environment's Advanced settings, then retry.",
      ),
    ),
    { cause },
  );
}

export async function resolveMeshSharedThread(
  payloads: ReadonlyArray<SharePayload>,
  isPairedEnvironment: (id: string) => boolean,
) {
  const [payload] = payloads;
  if (
    !clientCertificatesAvailable ||
    payloads.length !== 1 ||
    !payload ||
    (payload.shareType !== "url" && payload.shareType !== "text") ||
    /\s/.test(payload.value.trim())
  ) {
    return null;
  }
  const link = parseMeshThreadUrl(payload.value);
  if (!link) return null;
  const { environmentId } = link.target;
  // Only a paired machine's thread can open. This also keeps settings pages, which share the
  // bare /:environmentId/:threadId shape, in upstream's draft flow.
  if (!isPairedEnvironment(environmentId)) return null;
  if (!selectedClientCertificate(link.origin)) throw certificateError();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MESH_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(link.url.href, {
      method: "HEAD",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return link.target;
  } catch (cause) {
    throw certificateError(cause);
  } finally {
    clearTimeout(timeout);
  }
}
