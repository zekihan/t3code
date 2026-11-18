import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { pairedEnvironmentsByMachine } from "./meshEnvironments";

const machine = (name: string) => ({
  name,
  online: true,
  lastSeen: null,
  viewerOrigin: `https://t3.${name}.mesh.noqer.com`,
});
const environment = (id: string, displayUrl: string) => ({
  environmentId: id as EnvironmentId,
  displayUrl,
});

it("pairs a machine with the environment at its exact viewer origin", () => {
  const paired = pairedEnvironmentsByMachine(
    [machine("z-arch"), machine("z-mac")],
    [
      environment("e1", "https://t3.z-arch.mesh.noqer.com/"),
      environment("e2", "https://192.168.1.10:3773"),
      environment("e3", "https://t3.z-mac.mesh.noqer.com:8443"),
      environment("e4", "not a url"),
    ],
  );
  expect([...paired]).toEqual([["z-arch", "e1"]]);
});
