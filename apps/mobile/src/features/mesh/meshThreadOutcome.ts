import type { DirectStatus } from "./meshDirect.types";

export function shouldShowMeshThreadOutcome(
  outcome: DirectStatus["unknownOutcome"],
  refreshedAt: number | null,
): boolean {
  return outcome !== null && (refreshedAt === null || refreshedAt <= outcome.at);
}
