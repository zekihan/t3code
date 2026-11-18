import { Linking } from "react-native";
import { useCallback, useEffect, useRef, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import * as nativeApi from "./localNetwork";
import type { LocalNetworkState } from "./localNetwork.types";
import {
  createAskOnce,
  type LocalNetworkAccessApi,
  type LocalNetworkTrigger,
} from "./localNetworkLogic";

const confirmWithDialog = (title: string, message: string) =>
  new Promise<boolean>((resolve) =>
    Dialog.confirm({
      title,
      message,
      cancelText: "Not now",
      confirmText: "Continue",
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    }),
  );

const defaultApi: LocalNetworkAccessApi = {
  getState: nativeApi.getLocalNetworkState,
  request: nativeApi.requestLocalNetwork,
  confirm: confirmWithDialog,
};

// One for the app: the memory of what already asked outlives the screens that ask.
const sharedAsk = createAskOnce(defaultApi);

export interface LocalNetworkAccess {
  /** Null until read. */
  readonly state: LocalNetworkState | null;
  /** Asks for the permission when it is missing and this trigger has not asked yet. */
  readonly ask: (trigger: LocalNetworkTrigger) => Promise<LocalNetworkState>;
  readonly openSettings: () => void;
}

/** The local network permission (Android 17): its state, the prompt, and the way to Settings. */
export function useLocalNetworkAccess(): LocalNetworkAccess {
  const [state, setState] = useState<LocalNetworkState | null>(null);
  const live = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the permission is held natively; the effect mirrors it
  useEffect(() => {
    live.current = true;
    void defaultApi.getState().then(
      (next) => {
        if (live.current) setState(next);
      },
      () => undefined,
    );
    return () => {
      live.current = false;
    };
  }, []);
  const ask = useCallback(async (trigger: LocalNetworkTrigger) => {
    const next = await sharedAsk(trigger);
    if (live.current) setState(next);
    return next;
  }, []);
  const openSettings = useCallback(() => void Linking.openSettings(), []);
  return { state, ask, openSettings };
}
