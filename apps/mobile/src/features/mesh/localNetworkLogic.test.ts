import { describe, expect, it, vi } from "vite-plus/test";

import {
  createAskOnce,
  explainConnectionError,
  hostOfAddress,
  isLocalNetworkHost,
  LOCAL_NETWORK_DENIED,
  localNetworkRationale,
  type LocalNetworkAccessApi,
} from "./localNetworkLogic";
import type { LocalNetworkState } from "./localNetwork.types";

describe("isLocalNetworkHost", () => {
  it.each([
    "10.0.2.2",
    "172.16.0.1",
    "172.31.9.9",
    "192.168.2.81",
    "169.254.10.1",
    "100.64.0.9",
    "fd12:3456:789a:1::81",
    "[fd12:3456:789a:1::81]",
    "fe80::1",
    "printer.local",
    "NAS.LOCAL",
  ])("%s may be on the local network", (host) => {
    expect(isLocalNetworkHost(host)).toBe(true);
  });

  it.each([
    "example.com",
    "t3.z-arch.mesh.noqer.com",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "192.169.0.1",
    "300.1.1.1",
    "127.0.0.1",
    "::1",
    "2606:4700::1111",
    "localhost",
    "",
  ])("%s is not", (host) => {
    expect(isLocalNetworkHost(host)).toBe(false);
  });
});

describe("hostOfAddress", () => {
  it("reads the host of a bare address, a host with a port and a URL", () => {
    expect(hostOfAddress("192.168.2.41")).toBe("192.168.2.41");
    expect(hostOfAddress("192.168.2.41:3773")).toBe("192.168.2.41");
    expect(hostOfAddress("http://10.0.2.2:8443/pair?token=x")).toBe("10.0.2.2");
    expect(hostOfAddress("https://[fd00::1]:3773")).toBe("[fd00::1]");
  });

  it("returns null when there is nothing to read", () => {
    expect(hostOfAddress("")).toBeNull();
    expect(hostOfAddress("   ")).toBeNull();
    expect(hostOfAddress("http://")).toBeNull();
  });
});

function api(state: LocalNetworkState, agree = true) {
  const calls = { request: vi.fn(), confirm: vi.fn() };
  let current = state;
  const value: LocalNetworkAccessApi = {
    getState: () => Promise.resolve(current),
    request: () => {
      calls.request();
      current = "granted";
      return Promise.resolve({ state: current, canAskAgain: false });
    },
    confirm: (title, message) => {
      calls.confirm(title, message);
      return Promise.resolve(agree);
    },
  };
  return { value, calls };
}

describe("createAskOnce", () => {
  it("shows the rationale, then the system prompt, and reports the grant", async () => {
    const { value, calls } = api("denied");
    expect(await createAskOnce(value)("mesh-screen")).toBe("granted");
    expect(calls.confirm).toHaveBeenCalledWith(
      "Allow local network access?",
      localNetworkRationale("mesh-screen"),
    );
    expect(calls.request).toHaveBeenCalledOnce();
  });

  it("asks nothing where the permission is held or not required", async () => {
    for (const state of ["granted", "not-required"] as const) {
      const { value, calls } = api(state);
      expect(await createAskOnce(value)("mesh-screen")).toBe(state);
      expect(calls.confirm).not.toHaveBeenCalled();
      expect(calls.request).not.toHaveBeenCalled();
    }
  });

  it("asks at most once per trigger, but each trigger has its turn", async () => {
    const { value, calls } = api("denied", false);
    const ask = createAskOnce(value);
    expect(await ask("mesh-screen")).toBe("denied");
    expect(await ask("mesh-screen")).toBe("denied");
    expect(calls.confirm).toHaveBeenCalledOnce();
    expect(await ask("add-environment")).toBe("denied");
    expect(calls.confirm).toHaveBeenCalledTimes(2);
  });

  it("shows no system prompt when the person declines the rationale", async () => {
    const { value, calls } = api("denied", false);
    expect(await createAskOnce(value)("add-environment")).toBe("denied");
    expect(calls.request).not.toHaveBeenCalled();
  });

  it("gives each trigger its own words", () => {
    expect(localNetworkRationale("mesh-screen")).not.toBe(localNetworkRationale("add-environment"));
  });
});

describe("explainConnectionError", () => {
  it("replaces a timeout to a local network host while the permission is denied", () => {
    expect(explainConnectionError("Network request failed", "192.168.2.41", "denied")).toBe(
      LOCAL_NETWORK_DENIED,
    );
    expect(explainConnectionError("timeout", "nas.local", "denied")).toBe(LOCAL_NETWORK_DENIED);
    expect(
      explainConnectionError(
        "Remote environment endpoint http://10.0.2.2:38773/.well-known/t3/environment timed out after 10000ms.",
        "10.0.2.2",
        "denied",
      ),
    ).toBe(LOCAL_NETWORK_DENIED);
    expect(explainConnectionError("T3 Code on z-arch did not answer", "10.0.2.2", "denied")).toBe(
      LOCAL_NETWORK_DENIED,
    );
  });

  it("keeps the words of a failure that is not a timeout", () => {
    expect(explainConnectionError("The pairing code was not accepted.", "10.0.2.2", "denied")).toBe(
      "The pairing code was not accepted.",
    );
    expect(explainConnectionError("Enter a pairing code.", "10.0.2.2", "denied")).toBe(
      "Enter a pairing code.",
    );
  });

  it("leaves every other failure as it was", () => {
    expect(explainConnectionError("timeout", "192.168.2.41", "granted")).toBe("timeout");
    expect(explainConnectionError("timeout", "192.168.2.41", "not-required")).toBe("timeout");
    expect(explainConnectionError("timeout", "example.com", "denied")).toBe("timeout");
    expect(explainConnectionError("timeout", null, "denied")).toBe("timeout");
    expect(explainConnectionError(null, "192.168.2.41", "denied")).toBeNull();
  });

  it("says where to go", () => {
    expect(LOCAL_NETWORK_DENIED).toContain("Local network access denied");
    expect(LOCAL_NETWORK_DENIED).toContain("Settings");
  });
});
