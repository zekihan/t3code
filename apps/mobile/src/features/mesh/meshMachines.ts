import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import { meshViewerOrigin } from "./meshViewerUrl";

export interface MeshMachine {
  readonly name: string;
  readonly online: boolean;
  /** Epoch milliseconds, or null when the hub has never seen the machine. */
  readonly lastSeen: number | null;
  /** `https://t3.<name>.mesh.noqer.com`, already validated. */
  readonly viewerOrigin: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLastSeen(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The machines in a hub response, or null when the response is not a machine list at all.
 * An entry that is malformed or whose viewer URL is not its own mesh viewer origin is dropped,
 * and so is a repeated name: nothing is shown for it.
 */
export function parseMeshMachines(payload: unknown): MeshMachine[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.machines)) return null;
  const machines = new Map<string, MeshMachine>();
  for (const entry of payload.machines as unknown[]) {
    if (!isRecord(entry) || machines.has(entry.name as string)) continue;
    const viewerOrigin = meshViewerOrigin(entry.name, entry.viewerUrl);
    if (viewerOrigin === null || typeof entry.name !== "string") continue;
    machines.set(entry.name, {
      name: entry.name,
      online: entry.online === true,
      lastSeen: parseLastSeen(entry.lastSeen),
      viewerOrigin,
    });
  }
  return [...machines.values()];
}

/** Parses a list saved by `serializeMeshMachines`; anything else is an empty cache. */
export function readCachedMeshMachines(raw: string | null): MeshMachine[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !Array.isArray(value.machines)) return null;
    const machines = (value.machines as unknown[]).flatMap((entry): MeshMachine[] => {
      if (!isRecord(entry)) return [];
      const viewerOrigin = meshViewerOrigin(entry.name, entry.viewerOrigin);
      if (viewerOrigin === null || typeof entry.name !== "string") return [];
      return [
        {
          name: entry.name,
          online: entry.online === true,
          lastSeen: typeof entry.lastSeen === "number" ? entry.lastSeen : null,
          viewerOrigin,
        },
      ];
    });
    return machines;
  } catch {
    return null;
  }
}

export function serializeMeshMachines(machines: readonly MeshMachine[]): string {
  return JSON.stringify({ machines });
}

/** "just now", "5m ago", "3h ago", "2d ago"; "never seen" when the hub has no time. */
export function formatLastSeen(
  lastSeen: number | null,
  now: number,
  resolve: MessageResolver = m,
): string {
  if (lastSeen === null) return resolve(msg("Never seen"));
  const minutes = Math.floor(Math.max(0, now - lastSeen) / 60_000);
  if (minutes < 1) return resolve(msg("Seen just now"));
  if (minutes < 60) return resolve(msg("Seen {minutes}m ago", { minutes: String(minutes) }));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return resolve(msg("Seen {hours}h ago", { hours: String(hours) }));
  return resolve(msg("Seen {days}d ago", { days: String(Math.floor(hours / 24)) }));
}
