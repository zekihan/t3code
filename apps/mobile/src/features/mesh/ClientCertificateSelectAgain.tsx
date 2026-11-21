import { useState } from "react";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { chooseClientCertificate } from "../../lib/clientCertificates";

/** Offers the KeyChain picker for an environment whose saved certificate cannot be presented. */
export function ClientCertificateSelectAgain(props: {
  readonly url: string;
  readonly onSelected: () => void;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const choose = () => {
    setBusy(true);
    chooseClientCertificate(props.url)
      .then((alias) => {
        if (alias) props.onSelected();
      })
      .catch((error: unknown) => {
        Dialog.alert(
          gt("Client certificate"),
          error instanceof Error ? error.message : gt("Could not select certificate."),
        );
      })
      .finally(() => setBusy(false));
  };
  return (
    <View className="flex-row px-4 pb-3.5">
      <Button label={gt("Select certificate")} size="compact" loading={busy} onPress={choose} />
    </View>
  );
}
