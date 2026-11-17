import * as Dialog from "../components/ui/Dialog";

/**
 * An alert, not a confirm: the Android dialog host reports a replaced alert through `onDismiss`,
 * while a replaced confirm is dropped without an answer and would leave the prompt waiting forever.
 */
export function confirmIdentityChoice(origin: string, reason: string): Promise<boolean> {
  return new Promise((resolve) => {
    Dialog.alert(
      "Client certificate needed",
      `${origin} needs a client certificate: the saved one is ${
        reason === "missing" ? "no longer available" : reason
      }. Choose it again?`,
      [
        { text: "Not now", style: "cancel", onPress: () => resolve(false) },
        { text: "Choose", onPress: () => resolve(true) },
      ],
      { onDismiss: () => resolve(false) },
    );
  });
}
