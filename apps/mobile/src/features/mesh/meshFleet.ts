import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import { meshViewerOrigin } from "./meshViewerUrl";

/** Which of the hub's two entrypoints a connection came in on. */
export type MeshPath = "LAN" | "OCI";

export interface MeshFleetMachine {
  readonly name: string;
  /** A live tunnel session to the hub; says nothing about whether T3 itself is healthy. */
  readonly online: boolean;
  /** Epoch milliseconds, or null when the hub has never seen the machine. */
  readonly lastSeen: number | null;
  /** `https://t3.<name>.mesh.noqer.com`, already validated. */
  readonly viewerOrigin: string;
  readonly agentVersion: string | null;
  /** Epoch milliseconds when the machine's certificate expires, or null when unknown. */
  readonly certNotAfter: number | null;
  readonly tunnelPath: MeshPath | null;
  /** Epoch milliseconds when the current tunnel session began, or null. */
  readonly connectedSince: number | null;
  readonly alerts: readonly string[];
}

export interface MeshFleet {
  /** The path of the request that fetched the fleet, as the hub classified it. */
  readonly callerPath: MeshPath | null;
  readonly machines: readonly MeshFleetMachine[];
}

/** The hub request that produced a fleet: its path and how long the hub took to answer it. */
export interface MeshHubRequest {
  readonly path: MeshPath | null;
  readonly rttMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parsePath(value: unknown): MeshPath | null {
  return value === "LAN" || value === "OCI" ? value : null;
}

const MAX_ALERT_LENGTH = 64;

function parseAlerts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const alerts: string[] = [];
  for (const alert of value as unknown[]) {
    if (typeof alert !== "string" || alert === "" || alert.length > MAX_ALERT_LENGTH) continue;
    if (!alerts.includes(alert)) alerts.push(alert);
  }
  return alerts;
}

/**
 * The fleet in a hub response, or null when the response is not a fleet at all. An entry that is
 * malformed or whose viewer URL is not its own mesh viewer origin is dropped, and so is a
 * repeated name. Every other field is optional: the hub sends null for what it does not know.
 */
export function parseMeshFleet(payload: unknown): MeshFleet | null {
  if (!isRecord(payload) || !Array.isArray(payload.machines)) return null;
  const machines = new Map<string, MeshFleetMachine>();
  for (const entry of payload.machines as unknown[]) {
    if (!isRecord(entry) || typeof entry.name !== "string" || machines.has(entry.name)) continue;
    const viewerOrigin = meshViewerOrigin(entry.name, entry.viewerUrl);
    if (viewerOrigin === null) continue;
    const tunnel = isRecord(entry.tunnel) ? entry.tunnel : {};
    machines.set(entry.name, {
      name: entry.name,
      online: entry.online === true,
      lastSeen: parseTime(entry.lastSeen),
      viewerOrigin,
      agentVersion:
        typeof entry.agentVersion === "string" && entry.agentVersion !== ""
          ? entry.agentVersion
          : null,
      certNotAfter: parseTime(entry.certNotAfter),
      tunnelPath: parsePath(tunnel.path),
      connectedSince: parseTime(tunnel.connectedSince),
      alerts: parseAlerts(entry.alerts),
    });
  }
  return {
    callerPath: parsePath(isRecord(payload.caller) ? payload.caller.path : null),
    machines: [...machines.values()],
  };
}

export const CERT_WARNING_DAYS = 30;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatPath(path: MeshPath | null, resolve: MessageResolver = m): string {
  return path ?? resolve(msg("unknown", { $context: "network path of a connection" }));
}

/** "Up 3h 12m", "Up 2d 4h"; null when the hub gave no start time. */
export function formatTunnelUptime(
  connectedSince: number | null,
  now: number,
  resolve: MessageResolver = m,
): string | null {
  if (connectedSince === null) return null;
  const elapsed = Math.max(0, now - connectedSince);
  if (elapsed < MINUTE) return resolve(msg("Up less than a minute"));
  if (elapsed < HOUR) {
    return resolve(msg("Up {minutes}m", { minutes: String(Math.floor(elapsed / MINUTE)) }));
  }
  if (elapsed < DAY) {
    return resolve(
      msg("Up {hours}h {minutes}m", {
        hours: String(Math.floor(elapsed / HOUR)),
        minutes: String(Math.floor((elapsed % HOUR) / MINUTE)),
      }),
    );
  }
  return resolve(
    msg("Up {days}d {hours}h", {
      days: String(Math.floor(elapsed / DAY)),
      hours: String(Math.floor((elapsed % DAY) / HOUR)),
    }),
  );
}

export interface CertificateExpiry {
  readonly label: string;
  /** Expired, or fewer than `CERT_WARNING_DAYS` days left. */
  readonly warn: boolean;
}

/** "Certificate expires in 12 days", warning under 30 days; "expired 3 days ago" once past. */
export function formatCertificateExpiry(
  certNotAfter: number | null,
  now: number,
  resolve: MessageResolver = m,
): CertificateExpiry {
  if (certNotAfter === null)
    return { label: resolve(msg("Certificate expiry unknown")), warn: false };
  const remaining = certNotAfter - now;
  if (remaining <= 0) {
    const ago = -remaining;
    const label =
      ago < HOUR
        ? resolve(msg("Certificate expired just now"))
        : ago < DAY
          ? resolve(
              msg(
                "{count, plural, one {Certificate expired {count} hour ago} other {Certificate expired {count} hours ago}}",
                { count: Math.floor(ago / HOUR) },
              ),
            )
          : resolve(
              msg(
                "{count, plural, one {Certificate expired {count} day ago} other {Certificate expired {count} days ago}}",
                { count: Math.floor(ago / DAY) },
              ),
            );
    return { label, warn: true };
  }
  const label =
    remaining < HOUR
      ? resolve(msg("Certificate expires in under an hour"))
      : remaining < DAY
        ? resolve(
            msg(
              "{count, plural, one {Certificate expires in {count} hour} other {Certificate expires in {count} hours}}",
              { count: Math.floor(remaining / HOUR) },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Certificate expires in {count} day} other {Certificate expires in {count} days}}",
              { count: Math.floor(remaining / DAY) },
            ),
          );
  return { label, warn: remaining < CERT_WARNING_DAYS * DAY };
}

const ALERT_LABELS: Readonly<Record<string, string>> = {
  "cert-expiry": msg("Certificate expiring", { $context: "machine alert" }),
  disconnected: msg("Disconnected", { $context: "machine alert" }),
};

/** A known alert in the current language; an alert the app does not know is the hub's own text. */
export function formatAlert(alert: string, resolve: MessageResolver = m): string {
  const label = ALERT_LABELS[alert];
  return label === undefined ? alert : resolve(label);
}

export function formatRtt(rttMs: number, resolve: MessageResolver = m): string {
  return resolve(
    msg("{rtt} ms", {
      rtt: String(Math.max(0, Math.round(rttMs))),
      $context: "round-trip time in milliseconds",
    }),
  );
}

/**
 * The phone's hub request, labelled as what it is. The viewer connection is a different
 * connection and can take the other path (split DNS, a network change, a pooled connection).
 */
export function describeHubRequest(
  request: MeshHubRequest,
  resolve: MessageResolver = m,
): {
  readonly path: string;
  readonly rtt: string;
  readonly note: string;
} {
  return {
    path: resolve(msg("Hub request path: {path}", { path: formatPath(request.path, resolve) })),
    rtt: resolve(msg("Round-trip time: {rtt}", { rtt: formatRtt(request.rttMs, resolve) })),
    note: resolve(
      msg("This phone's last request to the hub; the viewer connection can use a different path."),
    ),
  };
}
