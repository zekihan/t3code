import { describe, expect, it } from "vite-plus/test";
import { parseEnrollmentQr, parseMeshPairingQr } from "./meshQrPayload";

const enrollmentToken = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno-_";
const viewer = "https://t3.z-arch.mesh.noqer.com";
const pairingCode = "23456789ABCD";

describe("enrollment QR payloads", () => {
  it.each([
    enrollmentToken,
    ` \n${enrollmentToken}\t`,
    `t3mesh://enroll?token=${enrollmentToken.replace("-_", "%2D%5F")}`,
  ])("reads an enrollment token from %s", (payload) => {
    expect(parseEnrollmentQr(payload)).toBe(enrollmentToken);
  });

  it.each([
    "   ",
    "junk",
    "https://example.com",
    "t3mesh://enroll",
    "t3mesh://enroll?token=%20",
    `t3mesh://other?token=${enrollmentToken}`,
    `t3mesh://enroll?token=${enrollmentToken}&token=junk`,
    `${enrollmentToken.slice(0, 10)} ${enrollmentToken.slice(10)}`,
  ])("rejects %j", (payload) => {
    expect(parseEnrollmentQr(payload)).toBeNull();
  });
});

describe("mesh pairing QR payloads", () => {
  it.each([
    pairingCode,
    "  2345-6789-abcd\n",
    `${viewer}/pair#token=${pairingCode}`,
    `  ${viewer}:443/pair?token=${pairingCode}\n`,
    `t3code://pair?pairingUrl=${encodeURIComponent(`${viewer}/pair#token=${pairingCode}`)}`,
  ])("reads a pairing code from %s", (payload) => {
    expect(parseMeshPairingQr(payload, viewer)).toEqual({ code: pairingCode });
  });

  it.each([
    `https://t3.z-mac.mesh.noqer.com/pair#token=${pairingCode}`,
    `http://t3.z-arch.mesh.noqer.com/pair#token=${pairingCode}`,
    `${viewer}:444/pair?token=${pairingCode}`,
    `${viewer}/pair?host=https://example.com#token=${pairingCode}`,
  ])("rejects a different pairing origin in %s", (payload) => {
    expect(parseMeshPairingQr(payload, viewer)).toEqual({ error: "origin-mismatch" });
  });

  it.each([
    "",
    "junk",
    enrollmentToken,
    `${viewer}/pair`,
    `${viewer}/pair#token=junk`,
    `https://someone@t3.z-arch.mesh.noqer.com/pair#token=${pairingCode}`,
  ])("rejects invalid pairing payload %j", (payload) => {
    expect(parseMeshPairingQr(payload, viewer)).toEqual({ error: "invalid-code" });
  });
});
