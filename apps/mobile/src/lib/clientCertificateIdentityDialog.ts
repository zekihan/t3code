import { msg } from "gt-react-native";

import * as Dialog from "../components/ui/Dialog";
import { m } from "../i18n/messages";

function identityChoiceMessage(origin: string, reason: string): string {
  if (reason === "missing")
    return m(
      msg(
        "{origin} needs a client certificate: the saved one is no longer available. Choose it again?",
        { origin },
      ),
    );
  if (reason === "expired")
    return m(
      msg("{origin} needs a client certificate: the saved one is expired. Choose it again?", {
        origin,
      }),
    );
  if (reason === "invalid")
    return m(
      msg("{origin} needs a client certificate: the saved one is invalid. Choose it again?", {
        origin,
      }),
    );
  return m(
    msg("{origin} needs a client certificate: the saved one is {reason}. Choose it again?", {
      origin,
      reason,
    }),
  );
}

/**
 * An alert, not a confirm: the Android dialog host reports a replaced alert through `onDismiss`,
 * while a replaced confirm is dropped without an answer and would leave the prompt waiting forever.
 */
export function confirmIdentityChoice(origin: string, reason: string): Promise<boolean> {
  return new Promise((resolve) => {
    Dialog.alert(
      m(msg("Client certificate needed")),
      identityChoiceMessage(origin, reason),
      [
        { text: m(msg("Not now")), style: "cancel", onPress: () => resolve(false) },
        {
          text: m(msg("Choose", { $context: "button, opens the certificate picker" })),
          onPress: () => resolve(true),
        },
      ],
      { onDismiss: () => resolve(false) },
    );
  });
}
