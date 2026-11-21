import type { EnvironmentId } from "@t3tools/contracts";

import type { MeshMachine } from "./meshMachines";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

interface PairableEnvironment {
  readonly environmentId: EnvironmentId;
  readonly displayUrl: string;
}

/** The paired environment at each machine's viewer origin, by machine name. */
export function pairedEnvironmentsByMachine(
  machines: readonly MeshMachine[],
  environments: readonly PairableEnvironment[],
): ReadonlyMap<string, EnvironmentId> {
  const byOrigin = new Map<string, EnvironmentId>();
  for (const environment of environments) {
    const origin = originOf(environment.displayUrl);
    if (origin !== null && !byOrigin.has(origin)) byOrigin.set(origin, environment.environmentId);
  }
  const paired = new Map<string, EnvironmentId>();
  for (const machine of machines) {
    const environmentId = byOrigin.get(machine.viewerOrigin);
    if (environmentId !== undefined) paired.set(machine.name, environmentId);
  }
  return paired;
}

export function unpairedMeshMachines(
  machines: readonly MeshMachine[] | null,
  environments: readonly PairableEnvironment[],
): readonly MeshMachine[] {
  if (machines === null) return [];
  const paired = pairedEnvironmentsByMachine(machines, environments);
  return machines.filter((machine) => !paired.has(machine.name));
}
