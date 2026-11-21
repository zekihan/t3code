import { expect, it } from "vite-plus/test";

import {
  formatLastSeen,
  parseMeshMachines,
  readCachedMeshMachines,
  serializeMeshMachines,
} from "./meshMachines";

const arch = {
  name: "z-arch",
  online: true,
  lastSeen: "2026-11-18T08:00:00Z",
  viewerUrl: "https://t3.z-arch.mesh.noqer.com",
};

it("parses the hub's machine list", () => {
  expect(
    parseMeshMachines({
      machines: [
        arch,
        {
          ...arch,
          name: "z-mac",
          online: false,
          lastSeen: null,
          viewerUrl: "https://t3.z-mac.mesh.noqer.com",
        },
      ],
    }),
  ).toEqual([
    {
      name: "z-arch",
      online: true,
      lastSeen: Date.parse("2026-11-18T08:00:00Z"),
      viewerOrigin: "https://t3.z-arch.mesh.noqer.com",
    },
    {
      name: "z-mac",
      online: false,
      lastSeen: null,
      viewerOrigin: "https://t3.z-mac.mesh.noqer.com",
    },
  ]);
});

it("treats an empty list as a list", () => {
  expect(parseMeshMachines({ machines: [] })).toEqual([]);
});

it.each([null, "x", 3, [], {}, { machines: "z-arch" }, { machines: { z: 1 } }])(
  "rejects %j as a machine list",
  (payload) => {
    expect(parseMeshMachines(payload)).toBeNull();
  },
);

it("drops an entry whose viewer URL is not its own mesh viewer origin and shows nothing for it", () => {
  const machines = parseMeshMachines({
    machines: [
      arch,
      { ...arch, name: "evil", viewerUrl: "https://t3.evil.mesh.noqer.com.attacker.example" },
      { ...arch, name: "swap", viewerUrl: "https://t3.z-arch.mesh.noqer.com" },
      { ...arch, name: "port", viewerUrl: "https://t3.port.mesh.noqer.com:8443" },
      { ...arch, name: "path", viewerUrl: "https://t3.path.mesh.noqer.com/x" },
      { ...arch, name: "http", viewerUrl: "http://t3.http.mesh.noqer.com" },
      { ...arch, name: "gone", viewerUrl: undefined },
      { ...arch, name: "Bad Name", viewerUrl: "https://t3.Bad Name.mesh.noqer.com" },
    ],
  });
  expect(machines?.map((machine) => machine.name)).toEqual(["z-arch"]);
});

it("drops entries that are not objects or lack a name", () => {
  const machines = parseMeshMachines({
    machines: [null, 4, "z-arch", [], { viewerUrl: arch.viewerUrl }, arch],
  });
  expect(machines?.map((machine) => machine.name)).toEqual(["z-arch"]);
});

it("keeps the first entry of a repeated name", () => {
  const machines = parseMeshMachines({ machines: [arch, { ...arch, online: false }] });
  expect(machines).toHaveLength(1);
  expect(machines?.[0]?.online).toBe(true);
});

it("reads online only from a literal true and an unreadable last seen as never", () => {
  const [machine] = parseMeshMachines({
    machines: [{ ...arch, online: "yes", lastSeen: "yesterday" }],
  })!;
  expect(machine?.online).toBe(false);
  expect(machine?.lastSeen).toBeNull();
});

it("round-trips through the saved cache and revalidates what it reads", () => {
  const machines = parseMeshMachines({ machines: [arch] })!;
  const checkedAt = Date.parse("2026-11-18T12:00:00Z");
  expect(readCachedMeshMachines(serializeMeshMachines(machines, checkedAt))).toEqual({
    machines,
    checkedAt,
  });
  const tampered = JSON.stringify({
    machines: [{ ...machines[0], viewerOrigin: "https://t3.evil.example" }, machines[0]],
  });
  expect(readCachedMeshMachines(tampered)).toEqual({ machines, checkedAt: null });
  expect(readCachedMeshMachines("not json")).toBeNull();
  expect(readCachedMeshMachines(null)).toBeNull();
  expect(readCachedMeshMachines(JSON.stringify({ machines: 3 }))).toBeNull();
});

it("formats the last seen time", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  expect(formatLastSeen(null, now)).toBe("Never seen");
  expect(formatLastSeen(now - 20_000, now)).toBe("Seen just now");
  expect(formatLastSeen(now + 60_000, now)).toBe("Seen just now");
  expect(formatLastSeen(now - 5 * 60_000, now)).toBe("Seen 5m ago");
  expect(formatLastSeen(now - 4 * 3_600_000, now)).toBe("Seen 4h ago");
  expect(formatLastSeen(now - 3 * 86_400_000, now)).toBe("Seen 3d ago");
});
