import {
  directCheck,
  PROBE_FAILURES,
  type DiagnosticCheck,
  type MeshDiagnostics,
} from "./meshDiagnostics";
import type { DirectDecisionEntry, DirectCheckRecord } from "./meshDirect.types";
import { MESH_HUB_URL, meshViewerOriginOf } from "./meshViewerUrl";

const VIEWER_REASONS = [
  "not-enrolled",
  "no-trust",
  "trust-expired",
  "no-route",
  "route-expired",
  "away",
  "local-network-denied",
  "probe-failed",
  "pending",
];
const HOME_RESULTS = ["home", "away", "unknown", "failed"];
const PROBE_RESULTS = ["ok", "stale", ...PROBE_FAILURES];

const CHECK_CODES = [
  "ok",
  "unsupported",
  "cancelled",
  "factory-installed",
  "factory-replaced",
  "no-certificate",
  "refused",
  "unavailable",
  "direct",
  "no-socket-route",
  "socket-opened",
  "socket-failed",
  "socket-timeout",
  "socket-prepare-failed",
  ...VIEWER_REASONS,
  ...PROBE_RESULTS,
];

const LOG_CODES: Readonly<Record<string, readonly string[]>> = {
  network: ["changed"],
  home: HOME_RESULTS,
  trust: ["ok", "failed"],
  probe: PROBE_RESULTS,
  path: ["direct", ...VIEWER_REASONS],
  stream: ["direct", "viewer"],
  fallback: ["pending", "proxy-unavailable", "stream-unavailable", ...PROBE_FAILURES],
};

function reportHost(url: string): string {
  try {
    const host = new URL(url).hostname;
    const origin = `https://${host}`;
    return origin === MESH_HUB_URL || meshViewerOriginOf(origin) !== null ? host : "[redacted]";
  } catch {
    return "[redacted]";
  }
}

function timestamp(at: number): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "unknown";
}

function reportCheck(label: string, { state, code, httpStatus }: DiagnosticCheck) {
  const safeState = (["pass", "fail", "skipped"] as const).includes(state) ? state : "unknown";
  const safeCode = CHECK_CODES.includes(code) ? code : "unknown";
  const status = httpStatus === 401 || httpStatus === 403 ? ` (HTTP ${httpStatus})` : "";
  return `${label}: ${safeState} · ${safeCode}${status}`;
}

function reportRecord(record: DirectCheckRecord | null, codes: readonly string[]) {
  return record
    ? `${codes.includes(record.result) ? record.result : "unknown"} at ${timestamp(record.at)}`
    : "none";
}

export function formatDecisionEntry(entry: DirectDecisionEntry): string | null {
  const codes = Object.hasOwn(LOG_CODES, entry.kind) ? LOG_CODES[entry.kind] : undefined;
  if (!codes?.includes(entry.result)) return null;
  const host = entry.host ? ` ${reportHost(`https://${entry.host}`)}` : "";
  return `${timestamp(entry.at)} ${entry.kind}${host}: ${entry.result}`;
}

export function trustAgeMinutes(fetchedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - fetchedAt) / 60_000));
}

export function meshDiagnosticsReport(report: MeshDiagnostics): string {
  const lines = [
    `Mesh diagnostics · ${timestamp(report.at)}`,
    reportCheck("React Native certificate transport", report.transport),
    reportCheck(`${reportHost(MESH_HUB_URL)}/api/v1/machines`, report.machines),
    reportCheck(`${reportHost(MESH_HUB_URL)}/api/v1/fleet`, report.fleet),
  ];
  for (const { origin, direct, socket, test } of report.paired) {
    lines.push("", reportHost(origin), reportCheck("Direct path", directCheck(direct)));
    if (direct) {
      const trust = direct.trustFetchedAt;
      lines.push(
        `Trust bundle age: ${trust === null || !Number.isFinite(trust) ? "unknown" : `${trustAgeMinutes(trust, report.at)} min`}`,
        `Last home check: ${reportRecord(direct.homeCheck, HOME_RESULTS)}`,
        `Last direct probe: ${reportRecord(direct.probe, PROBE_RESULTS)}`,
      );
    }
    lines.push(reportCheck("WebSocket", socket));
    if (test) lines.push(reportCheck("On-demand direct probe", test));
  }
  lines.push("", "Recent direct-path decisions");
  for (const entry of report.log) {
    const line = formatDecisionEntry(entry);
    if (line !== null) lines.push(line);
  }
  return lines.join("\n");
}
