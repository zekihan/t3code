import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import type { WidgetTheme } from "../../widgets/widgetTheme";
import type { DirectStatus } from "./meshDirect.types";
import type { EnrollmentStatus } from "./meshEnrollment.types";
import { formatCertificateExpiry, type MeshFleet } from "./meshFleet";

export type MeshWidgetPath = DirectStatus["path"] | "mixed" | "unknown";

export interface MeshWidgetSnapshot {
  readonly fleet: string;
  readonly path: string;
  readonly certificate: string;
  readonly certificateWarning: boolean;
  readonly checkedAt: number | null;
  readonly updated: string;
  readonly theme?: WidgetTheme;
}

export function summarizeMeshWidgetPaths(
  statuses: readonly (Pick<DirectStatus, "path"> | null)[],
): MeshWidgetPath {
  const direct = statuses.some((status) => status?.path === "direct");
  const viewer = statuses.some((status) => status?.path === "viewer");
  return direct && viewer ? "mixed" : direct ? "direct" : viewer ? "viewer" : "unknown";
}

const PATH_LABELS = {
  direct: msg("Direct at home"),
  viewer: msg("Via viewer"),
  mixed: msg("Direct and via viewer"),
  unknown: msg("Connection path unknown"),
} satisfies Record<MeshWidgetPath, string>;

export function buildMeshWidgetSnapshot(
  input: {
    readonly fleet: MeshFleet | null;
    readonly path: MeshWidgetPath;
    readonly enrollment: EnrollmentStatus | null;
    readonly checkedAt: number | null;
    readonly now: number;
    readonly locale: string;
  },
  resolve: MessageResolver = m,
): MeshWidgetSnapshot {
  const machines = input.fleet?.machines;
  const up = machines?.filter(
    (machine) => machine.online && machine.services.t3?.state === "reachable",
  ).length;
  const enrollment = input.enrollment;
  const certificate =
    enrollment === null
      ? { label: resolve(msg("Not enrolled")), warn: false }
      : enrollment.state !== "valid" || enrollment.notAfter <= input.now
        ? { label: resolve(msg("Re-enroll this device")), warn: true }
        : formatCertificateExpiry(enrollment.notAfter, input.now, resolve);

  return {
    fleet: machines
      ? resolve(msg("{up}/{total} machines up", { up: up ?? 0, total: machines.length }))
      : resolve(msg("Fleet status unavailable")),
    path: resolve(PATH_LABELS[input.path]),
    certificate: certificate.label,
    certificateWarning: certificate.warn,
    checkedAt: input.checkedAt,
    updated:
      input.checkedAt === null
        ? resolve(msg("No fleet update yet"))
        : resolve(
            msg("Updated {time}", {
              time: new Intl.DateTimeFormat(input.locale, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              }).format(input.checkedAt),
            }),
          ),
  };
}
