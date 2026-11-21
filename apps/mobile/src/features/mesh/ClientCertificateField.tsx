import { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react-native";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { clientCertificateWarning } from "../../lib/clientCertificateExpiry";
import {
  chooseClientCertificate,
  clientCertificatesAvailable,
  removeClientCertificate,
} from "../../lib/clientCertificates";
import { buildPairingUrl } from "../connection/pairing";
import { useClientCertificateStatus } from "./useClientCertificateStatus";

export function ClientCertificateField(props: { host: string; disabled?: boolean }) {
  const endpoint = buildPairingUrl(props.host, "certificate-origin");
  const gt = useGT();
  const m = useMessages();
  const { alias, status } = useClientCertificateStatus(endpoint);
  const warning = alias ? clientCertificateWarning(status, undefined, m) : null;
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  if (!clientCertificatesAvailable) return null;
  const act = (remove: boolean) => {
    setBusy(true);
    void (remove ? removeClientCertificate(endpoint) : chooseClientCertificate(endpoint))
      .catch((error: unknown) => {
        Dialog.alert(
          gt("Client certificate"),
          error instanceof Error ? error.message : gt("Could not select certificate."),
        );
      })
      .finally(() => setBusy(false));
  };
  const disabled = busy || props.disabled || !props.host.trim();
  return (
    <View className="rounded-xl bg-foreground/5">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="flex-row items-center justify-between px-4 py-3"
      >
        <View className="gap-1">
          <Text className="text-sm text-foreground-muted">
            <T>Advanced settings</T>
          </Text>
          {alias ? (
            <Text className="text-xs text-foreground-muted">
              <T>Certificate selected</T>
            </Text>
          ) : null}
          {warning ? (
            <Text accessibilityLiveRegion="polite" className="text-xs text-warning-foreground">
              {warning}
            </Text>
          ) : null}
        </View>
        <SymbolView
          name={expanded ? "chevron.up" : "chevron.down"}
          size={16}
          tintColorClassName="accent-icon-muted"
        />
      </Pressable>
      {expanded ? (
        <View className="gap-2 px-4 pb-3">
          <Text className="text-2xs font-t3-bold uppercase text-foreground-muted">
            <T>Client certificate (optional)</T>
          </Text>
          <Text className="text-sm text-foreground-muted">
            {alias ? (
              <T>
                <Var>{alias}</Var>. Applies to this HTTPS host and port, including other
                environments using the same address.
              </T>
            ) : (
              <T>
                None selected. Applies to this HTTPS host and port, including other environments
                using the same address.
              </T>
            )}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => act(false)}
            className="rounded-xl bg-input px-4 py-3"
          >
            <Text className="text-foreground">
              {busy
                ? gt("Please wait…")
                : alias
                  ? gt("Change certificate")
                  : gt("Select certificate")}
            </Text>
          </Pressable>
          {alias ? (
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => act(true)}
              className="px-4 py-2"
            >
              <Text className="text-danger-foreground">
                <T>Remove certificate</T>
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
