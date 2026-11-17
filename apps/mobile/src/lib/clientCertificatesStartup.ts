import { AppState } from "react-native";

import * as Dialog from "../components/ui/Dialog";
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

function confirm(origin: string, reason: string): Promise<boolean> {
  return new Promise((resolve) => {
    Dialog.confirm({
      title: "Client certificate needed",
      message: `${origin} needs a client certificate: the saved one is ${
        reason === "missing" ? "no longer available" : reason
      }. Choose it again?`,
      confirmText: "Choose",
      cancelText: "Not now",
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

if (clientCertificatesAvailable) {
  onClientCertificateIdentityProblem(
    createIdentityPrompt({ foreground, confirm, choose: chooseClientCertificate }),
  );
}
