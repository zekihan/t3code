import type { LocalNetworkRequestResult, LocalNetworkState } from "./localNetwork.types";

/** The moments the person is asked, at most once each per app start. */
export type LocalNetworkTrigger = "mesh-screen" | "add-environment";

export const LOCAL_NETWORK_DENIED = "Local network access denied. Allow it in Settings.";

const RATIONALE: Readonly<Record<LocalNetworkTrigger, string>> = {
  "mesh-screen":
    "Android 17 asks before an app talks to devices on your home network. T3 Mesh uses it to reach your machines directly when you are at home.",
  "add-environment":
    "Android 17 asks before an app talks to devices on your local network, and this address is on it.",
};

export const localNetworkRationale = (trigger: LocalNetworkTrigger): string => RATIONALE[trigger];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Whether `host` is a name or address the platform may count as local network: a private,
 * link-local or CGNAT IPv4 literal, a unique-local or link-local IPv6 literal, or a `.local` name.
 * Names that merely resolve to such an address cannot be told apart here.
 */
export function isLocalNetworkHost(host: string): boolean {
  const name = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (name.endsWith(".local")) return true;
  const v4 = IPV4.exec(name);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([1, 2, 3, 4].some((i) => Number(v4[i]) > 255)) return false;
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (!name.includes(":") || !/^[0-9a-f:.]+$/.test(name)) return false;
  const first = name.split(":")[0] ?? "";
  const word = first === "" ? 0 : Number.parseInt(first, 16);
  return (word & 0xfe00) === 0xfc00 || (word & 0xffc0) === 0xfe80;
}

/** The host of a pairing address or URL, or null when it has none to read. */
export function hostOfAddress(address: string): string | null {
  const text = address.trim();
  if (text === "") return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return url.hostname === "" ? null : url.hostname;
  } catch {
    return null;
  }
}

export interface LocalNetworkAccessApi {
  readonly getState: () => Promise<LocalNetworkState>;
  readonly request: () => Promise<LocalNetworkRequestResult>;
  /** Shows the rationale; resolves true when the person agrees to the system prompt. */
  readonly confirm: (title: string, message: string) => Promise<boolean>;
}

/** Remembers which triggers already asked, so a screen that opens again does not ask again. */
export function createAskOnce(api: LocalNetworkAccessApi) {
  const asked = new Set<LocalNetworkTrigger>();
  return async function ask(trigger: LocalNetworkTrigger): Promise<LocalNetworkState> {
    const state = await api.getState();
    if (state !== "denied" || asked.has(trigger)) return state;
    asked.add(trigger);
    const agreed = await api.confirm("Allow local network access?", localNetworkRationale(trigger));
    if (!agreed) return state;
    return (await api.request()).state;
  };
}

// What a connection that Android drops reads like by the time it reaches the screen: a timeout, or
// the connection layer saying the machine did not answer. A rejected code or a refused request is
// not one, and keeps its own words.
const UNREACHABLE =
  /timed? ?out|time-?out|did not answer|could not (?:reach|connect)|couldn't (?:reach|connect)|unreachable|failed to (?:connect|fetch)|fetch failed|network request failed/i;

/**
 * A connection failure to a local network host, worded for the missing permission: Android 17
 * drops the packets, so the app only ever sees a timeout. Anything else keeps its own text.
 */
export function explainConnectionError(
  error: string | null,
  host: string | null,
  state: LocalNetworkState,
): string | null {
  if (error === null || host === null) return error;
  return state === "denied" && isLocalNetworkHost(host) && UNREACHABLE.test(error)
    ? LOCAL_NETWORK_DENIED
    : error;
}
