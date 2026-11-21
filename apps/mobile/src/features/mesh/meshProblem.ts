import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import type { MeshProblem } from "./useMeshMachines";

const HUB_HOST = "hub.mesh.noqer.com";

export function problemTitle(
  kind: "no-certificate" | "refused" | "unavailable",
  resolve: MessageResolver = m,
) {
  switch (kind) {
    case "no-certificate":
      return resolve(msg("Choose your mesh identity"));
    case "refused":
      return resolve(msg("The hub refused this certificate"));
    case "unavailable":
      return resolve(msg("Can't reach the hub"));
  }
}

export function problemDetail(problem: MeshProblem, resolve: MessageResolver = m) {
  switch (problem.kind) {
    case "no-certificate":
      return (
        problem.message ??
        resolve(
          msg(
            "{host} lists your machines for the client certificate installed on this phone. Select it to continue.",
            { host: HUB_HOST },
          ),
        )
      );
    case "refused":
      return resolve(
        msg(
          "{host} answered HTTP {status}: this certificate is not admitted. Select another one if you have it.",
          { host: HUB_HOST, status: String(problem.status) },
        ),
      );
    case "unavailable":
      return problem.message;
  }
}
