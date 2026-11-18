import * as SecureStore from "expo-secure-store";

import { readCachedMeshMachines, serializeMeshMachines, type MeshMachine } from "./meshMachines";

const MESH_MACHINES_KEY = "t3mesh.machines";

/** The last list the hub returned, so the screen has something to show before the hub answers. */
export async function loadCachedMeshMachines(): Promise<MeshMachine[] | null> {
  try {
    return readCachedMeshMachines(await SecureStore.getItemAsync(MESH_MACHINES_KEY));
  } catch {
    return null;
  }
}

export async function saveCachedMeshMachines(machines: readonly MeshMachine[]): Promise<void> {
  try {
    await SecureStore.setItemAsync(MESH_MACHINES_KEY, serializeMeshMachines(machines));
  } catch {
    // The cache only speeds up the next open.
  }
}
