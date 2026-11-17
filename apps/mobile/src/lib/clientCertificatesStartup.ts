import { AppState } from "react-native";

import { confirmIdentityChoice } from "./clientCertificateIdentityDialog";
import { createIdentityPrompt } from "./clientCertificatePrompt";
import {
  chooseClientCertificate,
  clientCertificatesAvailable,
  onClientCertificateIdentityProblem,
} from "./clientCertificates";

function foreground(): Promise<void> {
  if (AppState.currentState === "active") return Promise.resolve();
  return new Promise((resolve) => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      subscription.remove();
      resolve();
    });
  });
}

if (clientCertificatesAvailable) {
  onClientCertificateIdentityProblem(
    createIdentityPrompt({
      foreground,
      confirm: confirmIdentityChoice,
      choose: chooseClientCertificate,
    }),
  );
}
