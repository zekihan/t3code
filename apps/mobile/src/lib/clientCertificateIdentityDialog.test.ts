import { beforeEach, expect, it, vi } from "vite-plus/test";

const alert = vi.hoisted(() => vi.fn());
vi.mock("../components/ui/Dialog", () => ({ alert }));

import { confirmIdentityChoice } from "./clientCertificateIdentityDialog";

type AlertArgs = [
  string,
  string,
  { text: string; onPress: () => void }[],
  { onDismiss: () => void },
];

beforeEach(() => alert.mockReset());

function shown() {
  return alert.mock.calls[0] as AlertArgs;
}

it("names the origin and why the saved certificate is unusable", () => {
  void confirmIdentityChoice("https://t3.example/", "missing");
  expect(shown()[1]).toBe(
    "https://t3.example/ needs a client certificate: the saved one is no longer available. Choose it again?",
  );
  void confirmIdentityChoice("https://t3.example/", "expired");
  expect((alert.mock.calls[1] as AlertArgs)[1]).toContain("the saved one is expired");
});

it("resolves true on Choose and false on Not now", async () => {
  const choose = confirmIdentityChoice("https://t3.example/", "missing");
  shown()[2]
    .find((button) => button.text === "Choose")
    ?.onPress();
  await expect(choose).resolves.toBe(true);
  alert.mockReset();
  const decline = confirmIdentityChoice("https://t3.example/", "missing");
  shown()[2]
    .find((button) => button.text === "Not now")
    ?.onPress();
  await expect(decline).resolves.toBe(false);
});

it("resolves false when another dialog replaces it, so the prompt is not stuck waiting", async () => {
  const replaced = confirmIdentityChoice("https://t3.example/", "missing");
  shown()[3].onDismiss();
  await expect(replaced).resolves.toBe(false);
});
