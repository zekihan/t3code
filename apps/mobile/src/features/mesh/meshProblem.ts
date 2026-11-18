import type { MeshProblem } from "./useMeshMachines";

export function problemTitle(kind: "no-certificate" | "refused" | "unavailable") {
  switch (kind) {
    case "no-certificate":
      return "Choose your mesh identity";
    case "refused":
      return "The hub refused this certificate";
    case "unavailable":
      return "Can't reach the hub";
  }
}

export function problemDetail(problem: MeshProblem) {
  switch (problem.kind) {
    case "no-certificate":
      return (
        problem.message ??
        "hub.mesh.noqer.com lists your machines for the client certificate installed on this phone. Select it to continue."
      );
    case "refused":
      return `hub.mesh.noqer.com answered HTTP ${problem.status}: this certificate is not admitted. Select another one if you have it.`;
    case "unavailable":
      return problem.message;
  }
}
