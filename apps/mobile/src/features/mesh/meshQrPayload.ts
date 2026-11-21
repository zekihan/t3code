import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "@t3tools/contracts";
import {
  getPairingTokenFromUrl,
  readHostedPairingRequest,
  readPairingAppLink,
} from "@t3tools/shared/remote";

// The hub prints 32 random bytes as unpadded base64url.
const ENROLLMENT_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PAIRING_CODE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`, "i");

export function parseEnrollmentQr(payload: string): string | null {
  const text = payload.trim();
  if (ENROLLMENT_TOKEN.test(text)) return text;

  try {
    const url = new URL(text);
    if (
      url.protocol !== "t3mesh:" ||
      url.host !== "enroll" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null;
    }
    const [token, ...duplicates] = url.searchParams.getAll("token");
    const value = token?.trim() ?? "";
    return duplicates.length === 0 && ENROLLMENT_TOKEN.test(value) ? value : null;
  } catch {
    return null;
  }
}

type MeshPairingQrResult = { code: string } | { error: "invalid-code" | "origin-mismatch" };

function normalizePairingCode(value: string): string | null {
  const code = value.replace(/[\s-]/g, "");
  return PAIRING_CODE.test(code) ? code.toUpperCase() : null;
}

export function parseMeshPairingQr(payload: string, viewerOrigin: string): MeshPairingQrResult {
  const text = payload.trim();
  const rawCode = normalizePairingCode(text);
  if (rawCode) return { code: rawCode };

  try {
    const url = new URL(readPairingAppLink(text) ?? text);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      return { error: "invalid-code" };
    }
    const token = getPairingTokenFromUrl(url);
    const code = token && normalizePairingCode(token);
    if (!code) return { error: "invalid-code" };

    const expectedOrigin = new URL(viewerOrigin).origin;
    const hosted = readHostedPairingRequest(url);
    if (
      url.origin !== expectedOrigin ||
      (hosted && new URL(hosted.host).origin !== expectedOrigin)
    ) {
      return { error: "origin-mismatch" };
    }
    return { code };
  } catch {
    return { error: "invalid-code" };
  }
}
