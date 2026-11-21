import { expect, it } from "vite-plus/test";

import { shouldShowMeshThreadOutcome } from "./meshThreadOutcome";

const outcome = { at: 100, method: "POST" };

it.each([
  [null, null, false],
  [null, 99, false],
  [outcome, null, true],
  [outcome, 99, true],
  [outcome, 100, true],
  [outcome, 101, false],
  [{ ...outcome, at: 102 }, 101, true],
] as const)("shows outcome %j after refresh %j: %s", (unknownOutcome, refreshedAt, visible) => {
  expect(shouldShowMeshThreadOutcome(unknownOutcome, refreshedAt)).toBe(visible);
});
