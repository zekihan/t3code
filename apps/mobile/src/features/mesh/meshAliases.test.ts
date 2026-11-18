import { expect, it, vi } from "vite-plus/test";

vi.mock("../../lib/clientCertificates", () => ({
  assignMeshClientCertificate: vi.fn(),
  meshClientCertificateOrigins: vi.fn(() => []),
  releaseMeshClientCertificate: vi.fn(),
  selectedClientCertificate: vi.fn(() => null),
}));

import { syncMeshAliases, type MeshAliasApi } from "./meshAliases";
import type { MeshMachine } from "./meshMachines";

const origin = (name: string) => `https://t3.${name}.mesh.noqer.com`;
const machine = (name: string): MeshMachine => ({
  name,
  online: true,
  lastSeen: null,
  viewerOrigin: origin(name),
});

/** The native store's rules: an alias is the app's only while its marker equals it. */
function fakeNative(hubAlias: string | null, initial: Record<string, string> = {}) {
  const aliases = new Map(Object.entries(initial));
  const markers = new Map<string, string>();
  const key = (url: string) => new URL(url).origin;
  const api: MeshAliasApi = {
    hubAlias: () => hubAlias,
    assign: async (url, alias) => {
      const o = key(url);
      const current = aliases.get(o);
      if (current !== undefined && markers.get(o) !== current) return false;
      aliases.set(o, alias);
      markers.set(o, alias);
      return true;
    },
    release: async (url) => {
      const o = key(url);
      const owned = markers.has(o) && markers.get(o) === aliases.get(o);
      if (!markers.has(o)) return false;
      markers.delete(o);
      if (owned) aliases.delete(o);
      return owned;
    },
    assigned: () => [...markers.keys()].map((o) => `${o}/`),
  };
  const choose = (o: string, alias: string) => {
    aliases.set(o, alias);
    markers.delete(o);
  };
  return { api, aliases, markers, choose };
}

it("gives each listed machine's viewer origin the hub's alias", async () => {
  const native = fakeNative("hub-id");
  const result = await syncMeshAliases(native.api, [machine("z-arch"), machine("z-mac")]);
  expect(result.assigned).toEqual([origin("z-arch"), origin("z-mac")]);
  expect(Object.fromEntries(native.aliases)).toEqual({
    [origin("z-arch")]: "hub-id",
    [origin("z-mac")]: "hub-id",
  });
});

it("never reaches an origin that is not a listed machine's", async () => {
  const native = fakeNative("hub-id");
  await syncMeshAliases(native.api, [machine("z-arch")]);
  expect([...native.aliases.keys()]).toEqual([origin("z-arch")]);
  expect(native.aliases.has("https://preview.z-arch.mesh.noqer.com")).toBe(false);
  expect(native.aliases.has("https://t3.unlisted.mesh.noqer.com")).toBe(false);
});

it("does not overwrite an alias the person chose", async () => {
  const native = fakeNative("hub-id", { [origin("z-arch")]: "my-own" });
  const result = await syncMeshAliases(native.api, [machine("z-arch"), machine("z-mac")]);
  expect(result.keptOwn).toEqual([origin("z-arch")]);
  expect(result.assigned).toEqual([origin("z-mac")]);
  expect(native.aliases.get(origin("z-arch"))).toBe("my-own");
});

it("keeps a person's choice even when it names the hub's alias, and never removes it", async () => {
  const native = fakeNative("hub-id", { [origin("z-arch")]: "hub-id" });
  await syncMeshAliases(native.api, [machine("z-arch")]);
  await syncMeshAliases(native.api, []);
  expect(native.aliases.get(origin("z-arch"))).toBe("hub-id");
});

it("removes the alias it assigned when the machine is no longer listed", async () => {
  const native = fakeNative("hub-id");
  await syncMeshAliases(native.api, [machine("z-arch"), machine("z-mac")]);
  const result = await syncMeshAliases(native.api, [machine("z-arch")]);
  expect(result.released).toEqual([origin("z-mac")]);
  expect([...native.aliases.keys()]).toEqual([origin("z-arch")]);
});

it("leaves a person's alias alone when its machine is unlisted, and forgets the claim", async () => {
  const native = fakeNative("hub-id");
  await syncMeshAliases(native.api, [machine("z-arch")]);
  native.choose(origin("z-arch"), "my-own");
  const result = await syncMeshAliases(native.api, []);
  expect(result.released).toEqual([]);
  expect(native.aliases.get(origin("z-arch"))).toBe("my-own");
  expect(native.markers.size).toBe(0);
});

it("follows a replaced hub alias for the origins it assigned", async () => {
  const native = fakeNative("old");
  await syncMeshAliases(native.api, [machine("z-arch")]);
  const renewed = { ...native.api, hubAlias: () => "renewed" };
  await syncMeshAliases(renewed, [machine("z-arch")]);
  expect(native.aliases.get(origin("z-arch"))).toBe("renewed");
});

it("does nothing without a hub alias", async () => {
  const native = fakeNative(null);
  const assign = vi.spyOn(native.api, "assign");
  const result = await syncMeshAliases(native.api, [machine("z-arch")]);
  expect(result).toEqual({ assigned: [], keptOwn: [], released: [], failed: [] });
  expect(assign).not.toHaveBeenCalled();
});

it("keeps going when one origin fails", async () => {
  const native = fakeNative("hub-id");
  const assign = native.api.assign;
  const api: MeshAliasApi = {
    ...native.api,
    assign: (url, alias) =>
      url === origin("z-arch") ? Promise.reject(new Error("KeyChain")) : assign(url, alias),
  };
  const result = await syncMeshAliases(api, [machine("z-arch"), machine("z-mac")]);
  expect(result.failed).toEqual([origin("z-arch")]);
  expect(result.assigned).toEqual([origin("z-mac")]);
});

it("assigns and releases nothing for an enrolled identity: the transport applies it itself", async () => {
  const native = fakeNative("enrolled:device-z-phone-mesh", { [origin("old")]: "kept" });
  native.markers.set(origin("gone"), "old-hub-id");
  native.aliases.set(origin("gone"), "old-hub-id");
  const result = await syncMeshAliases(native.api, [machine("z-arch")]);
  expect(result).toEqual({ assigned: [], keptOwn: [], released: [], failed: [] });
  expect(native.aliases.has(origin("z-arch"))).toBe(false);
  // The KeyChain-era alias for a machine that is gone stays until the enrollment is removed.
  expect(native.aliases.get(origin("gone"))).toBe("old-hub-id");
});
