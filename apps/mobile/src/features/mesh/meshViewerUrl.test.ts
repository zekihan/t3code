import { expect, it } from "vite-plus/test";

import { meshViewerOrigin } from "./meshViewerUrl";

it("accepts exactly the machine's own viewer origin", () => {
  expect(meshViewerOrigin("z-arch", "https://t3.z-arch.mesh.noqer.com")).toBe(
    "https://t3.z-arch.mesh.noqer.com",
  );
  expect(meshViewerOrigin("z-arch", "https://t3.z-arch.mesh.noqer.com/")).toBe(
    "https://t3.z-arch.mesh.noqer.com",
  );
  expect(meshViewerOrigin("z1", "https://t3.z1.mesh.noqer.com")).toBe(
    "https://t3.z1.mesh.noqer.com",
  );
  expect(meshViewerOrigin("a", "https://t3.a.mesh.noqer.com")).not.toBeNull();
});

it.each([
  ["another machine's host", "z-arch", "https://t3.z-mac.mesh.noqer.com"],
  ["another service", "z-arch", "https://preview.z-arch.mesh.noqer.com"],
  ["the hub", "z-arch", "https://hub.mesh.noqer.com"],
  ["a foreign domain", "z-arch", "https://t3.z-arch.mesh.noqer.com.evil.example"],
  ["a sibling domain", "z-arch", "https://t3.z-arch.mesh.noqer.net"],
  ["a prefixed host", "z-arch", "https://x.t3.z-arch.mesh.noqer.com"],
  ["a nested machine label", "z-arch", "https://t3.sub.z-arch.mesh.noqer.com"],
  ["plain http", "z-arch", "http://t3.z-arch.mesh.noqer.com"],
  ["a port", "z-arch", "https://t3.z-arch.mesh.noqer.com:8443"],
  ["the default port spelled out", "z-arch", "https://t3.z-arch.mesh.noqer.com:443"],
  ["userinfo", "z-arch", "https://user@t3.z-arch.mesh.noqer.com"],
  ["userinfo that hides the host", "z-arch", "https://t3.z-arch.mesh.noqer.com@evil.example"],
  ["a path", "z-arch", "https://t3.z-arch.mesh.noqer.com/app"],
  ["a doubled slash", "z-arch", "https://t3.z-arch.mesh.noqer.com//"],
  ["a query", "z-arch", "https://t3.z-arch.mesh.noqer.com/?x=1"],
  ["a fragment", "z-arch", "https://t3.z-arch.mesh.noqer.com/#x"],
  ["a backslash path", "z-arch", "https://t3.z-arch.mesh.noqer.com\\@evil.example"],
  ["upper case", "z-arch", "https://T3.Z-ARCH.mesh.noqer.com"],
  ["surrounding space", "z-arch", " https://t3.z-arch.mesh.noqer.com"],
  ["a trailing newline", "z-arch", "https://t3.z-arch.mesh.noqer.com\n"],
  ["a trailing dot", "z-arch", "https://t3.z-arch.mesh.noqer.com."],
  ["an empty string", "z-arch", ""],
  ["a scheme-relative URL", "z-arch", "//t3.z-arch.mesh.noqer.com"],
])("refuses %s", (_label, name, url) => {
  expect(meshViewerOrigin(name, url)).toBeNull();
});

it.each([
  ["an empty name", ""],
  ["a name with upper case", "Z-Arch"],
  ["a name with a dot", "z.arch"],
  ["a name with a slash", "z/arch"],
  ["a name with a space", "z arch"],
  ["a leading hyphen", "-z"],
  ["a trailing hyphen", "z-"],
  ["an underscore", "z_arch"],
  ["a wildcard", "*"],
  ["a name over 63 characters", "a".repeat(64)],
  ["a regex-looking name", ".+"],
])("refuses %s as a machine name", (_label, name) => {
  expect(meshViewerOrigin(name, `https://t3.${name}.mesh.noqer.com`)).toBeNull();
});

it("accepts a 63-character machine name", () => {
  const name = "a".repeat(63);
  expect(meshViewerOrigin(name, `https://t3.${name}.mesh.noqer.com`)).not.toBeNull();
});

it("refuses values that are not strings", () => {
  expect(meshViewerOrigin("z-arch", undefined)).toBeNull();
  expect(meshViewerOrigin("z-arch", 7)).toBeNull();
  expect(meshViewerOrigin(null, "https://t3.z-arch.mesh.noqer.com")).toBeNull();
});
