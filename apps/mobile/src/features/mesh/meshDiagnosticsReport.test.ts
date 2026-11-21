import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { meshDiagnosticsReport } from "./meshDiagnosticsReport";

it("only exports recognized check fields, decision codes and mesh viewer or hub hostnames", () => {
  const sensitive = [
    "10.20.30.40",
    "fd12:3456::abcd",
    "::ffff:172.19.0.2",
    "27443",
    "relay.example.org",
    "my-nas",
    "super-secret-hub-token",
    "pairing-ticket",
    "private-key-body",
    "cert-body",
    "11223344556677889900aabbccddeeff",
  ];
  const detail = `connect ${sensitive.slice(0, 6).join(" ")} Authorization: Bearer ${sensitive[6]}
    ?wsTicket=${sensitive[7]}
    -----BEGIN PRIVATE KEY-----
    ${sensitive[8]}
    -----END PRIVATE KEY-----
    -----BEGIN CERTIFICATE-----
    ${sensitive[9]}
    -----END CERTIFICATE-----
    fingerprint=${sensitive[10]}`;
  const report = meshDiagnosticsReport({
    at: 180_000,
    transport: { state: "pass", code: "factory-installed" },
    machines: { state: "fail", code: "unavailable", detail },
    fleet: { state: "fail", code: "refused", httpStatus: 403 },
    paired: [
      {
        environmentId: EnvironmentId.make("my-nas"),
        origin:
          "https://user:super-secret-hub-token@t3.dev.mesh.noqer.com:27443/ws?wsTicket=pairing-ticket",
        direct: {
          path: "viewer",
          reason: "probe-failed",
          trustFetchedAt: 0,
          homeCheck: { at: 60_000, result: "home" },
          probe: { at: 120_000, result: detail },
        },
        socket: { state: "fail", code: "socket-timeout", detail },
        test: { state: "fail", code: "timeout" },
      },
      ...[
        "https://10.20.30.40:27443",
        "https://[fd12:3456::abcd]:27443",
        "https://relay.example.org:27443",
        "https://my-nas:27443",
      ].map((origin) => ({
        origin,
        environmentId: EnvironmentId.make("my-nas"),
        direct: null,
        socket: { state: "fail" as const, code: detail },
      })),
    ],
    log: [
      { at: 4242, kind: "probe", result: "authorization", host: "t3.dev.mesh.noqer.com:27443" },
      { at: 4000, kind: "fallback", result: "timeout", host: "relay.example.org" },
      { at: 4001, kind: "home", result: detail, host: null },
      { at: 4002, kind: detail, result: "ok", host: null },
    ],
  });

  for (const secret of sensitive) expect(report).not.toContain(secret);
  expect(report).not.toMatch(/BEGIN|END|Bearer|wsTicket/);
  expect(report).toContain("hub.mesh.noqer.com/api/v1/fleet: fail · refused (HTTP 403)");
  expect(report).toContain("Trust bundle age: 3 min");
  expect(report).toContain("On-demand direct probe: fail · timeout");
  expect(report).toContain("probe t3.dev.mesh.noqer.com: authorization");
  expect(report).toContain("fallback [redacted]: timeout");
});
