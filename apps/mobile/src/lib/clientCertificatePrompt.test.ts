import { describe, expect, it, vi } from "vite-plus/test";

import { createIdentityPrompt } from "./clientCertificatePrompt";

const origin = "https://t3.example.test:443/";

function setup(overrides: { confirm?: boolean; choose?: unknown } = {}) {
  let time = 1_000;
  const deps = {
    foreground: vi.fn(async () => {}),
    confirm: vi.fn(async () => overrides.confirm ?? true),
    choose: vi.fn(async () => ("choose" in overrides ? overrides.choose : "phone")),
    now: () => time,
    cooldownMs: 60_000,
  };
  return { deps, prompt: createIdentityPrompt(deps), advance: (ms: number) => (time += ms) };
}

describe("createIdentityPrompt", () => {
  it("asks for the identity again once the app is in the foreground", async () => {
    const { deps, prompt } = setup();
    await prompt({ origin, reason: "missing" });
    expect(deps.foreground).toHaveBeenCalledOnce();
    expect(deps.confirm).toHaveBeenCalledWith(origin, "missing");
    expect(deps.choose).toHaveBeenCalledWith(origin);
  });

  it("shows one prompt for the reconnect attempts that arrive while it is open", async () => {
    const { deps, prompt } = setup();
    await Promise.all([
      prompt({ origin, reason: "missing" }),
      prompt({ origin, reason: "missing" }),
      prompt({ origin, reason: "missing" }),
    ]);
    expect(deps.confirm).toHaveBeenCalledOnce();
  });

  it("stays quiet after a dismissal until the cooldown ends", async () => {
    const { deps, prompt, advance } = setup({ confirm: false });
    await prompt({ origin, reason: "expired" });
    await prompt({ origin, reason: "expired" });
    expect(deps.confirm).toHaveBeenCalledOnce();
    advance(60_001);
    await prompt({ origin, reason: "expired" });
    expect(deps.confirm).toHaveBeenCalledTimes(2);
    expect(deps.choose).not.toHaveBeenCalled();
  });

  it("treats a cancelled picker like a dismissal", async () => {
    const { deps, prompt } = setup({ choose: null });
    await prompt({ origin, reason: "missing" });
    await prompt({ origin, reason: "missing" });
    expect(deps.choose).toHaveBeenCalledOnce();
  });

  it("prompts again at once after a certificate was chosen", async () => {
    const { deps, prompt } = setup();
    await prompt({ origin, reason: "missing" });
    await prompt({ origin, reason: "missing" });
    expect(deps.confirm).toHaveBeenCalledTimes(2);
  });

  it("keeps origins independent and survives a picker failure", async () => {
    const { deps, prompt } = setup();
    deps.choose.mockRejectedValueOnce(new Error("picker busy"));
    await prompt({ origin, reason: "missing" });
    await prompt({ origin: "https://other.example.test:443/", reason: "missing" });
    expect(deps.choose).toHaveBeenCalledTimes(2);
  });
});
