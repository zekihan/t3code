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

export function formatPath(path: MeshPath | null): string {
  return path ?? "unknown";
}

/** "Up 3h 12m", "Up 2d 4h"; null when the hub gave no start time. */
export function formatTunnelUptime(connectedSince: number | null, now: number): string | null {
  if (connectedSince === null) return null;
  const elapsed = Math.max(0, now - connectedSince);
  if (elapsed < MINUTE) return "Up less than a minute";
  if (elapsed < HOUR) return `Up ${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) {
    return `Up ${Math.floor(elapsed / HOUR)}h ${Math.floor((elapsed % HOUR) / MINUTE)}m`;
  }
  return `Up ${Math.floor(elapsed / DAY)}d ${Math.floor((elapsed % DAY) / HOUR)}h`;
}

export interface CertificateExpiry {
  readonly label: string;
  /** Expired, or fewer than `CERT_WARNING_DAYS` days left. */
  readonly warn: boolean;
}

function plural(count: number, unit: string) {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** "Certificate expires in 12 days", warning under 30 days; "expired 3 days ago" once past. */
export function formatCertificateExpiry(
  certNotAfter: number | null,
  now: number,
): CertificateExpiry {
  if (certNotAfter === null) return { label: "Certificate expiry unknown", warn: false };
  const remaining = certNotAfter - now;
  if (remaining <= 0) {
    const ago = -remaining;
    const label =
      ago < HOUR
        ? "Certificate expired just now"
        : ago < DAY
          ? `Certificate expired ${plural(Math.floor(ago / HOUR), "hour")} ago`
          : `Certificate expired ${plural(Math.floor(ago / DAY), "day")} ago`;
    return { label, warn: true };
  }
  const label =
    remaining < HOUR
      ? "Certificate expires in under an hour"
      : remaining < DAY
        ? `Certificate expires in ${plural(Math.floor(remaining / HOUR), "hour")}`
        : `Certificate expires in ${plural(Math.floor(remaining / DAY), "day")}`;
  return { label, warn: remaining < CERT_WARNING_DAYS * DAY };
}

const ALERT_LABELS: Readonly<Record<string, string>> = {
  "cert-expiry": "Certificate expiring",
  disconnected: "Disconnected",
};

export function formatAlert(alert: string): string {
  return ALERT_LABELS[alert] ?? alert;
}

export function formatRtt(rttMs: number): string {
  return `${Math.max(0, Math.round(rttMs))} ms`;
}

/**
 * The phone's hub request, labelled as what it is. The viewer connection is a different
 * connection and can take the other path (split DNS, a network change, a pooled connection).
 */
export function describeHubRequest(request: MeshHubRequest): {
  readonly path: string;
  readonly rtt: string;
  readonly note: string;
} {
  return {
    path: `Hub request path: ${formatPath(request.path)}`,
    rtt: `Round-trip time: ${formatRtt(request.rttMs)}`,
    note: "This phone's last request to the hub; the viewer connection can use a different path.",
  };
}
