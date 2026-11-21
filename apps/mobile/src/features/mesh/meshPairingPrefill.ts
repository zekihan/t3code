import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useMessages, msg } from "gt-react-native";
import { parseMeshPairingQr } from "./meshQrPayload";

export const meshPairingOriginAtom = Atom.make<string | null>(null).pipe(
  Atom.withLabel("mesh-pairing-origin"),
);

export function useMeshPairingPrefill(requestedOrigin: string | undefined) {
  const origin = useAtomValue(meshPairingOriginAtom);
  const m = useMessages();
  // A route can select the app's prefill but cannot supply a production address.
  if (!origin || origin !== requestedOrigin) return null;

  return {
    origin,
    readScan: (payload: string) => {
      const result = parseMeshPairingQr(payload, origin);
      if ("code" in result) return result;

      return {
        error:
          result.error === "origin-mismatch"
            ? m(msg("This pairing code is for a different address."))
            : m(msg("This QR code is not a pairing code.")),
      };
    },
  };
}
