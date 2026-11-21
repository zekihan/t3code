import { useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import { clientCertificatesAvailable } from "../../lib/clientCertificates";
import { openSettings } from "../settings/settings-navigation";

/** Offered under "No environments connected": the machines the hub lists are one tap from pairing. */
export function MeshEmptyStateLink() {
  const navigation = useNavigation();
  const gt = useGT();
  if (!clientCertificatesAvailable) return null;
  return (
    <View className="mt-3 flex-row justify-center">
      <Button
        tone="text"
        label={gt("Find machines on the mesh")}
        onPress={() => openSettings(navigation, "SettingsMesh")}
      />
    </View>
  );
}
