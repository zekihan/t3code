import { useGT } from "gt-react-native";
import { useEffect, useState } from "react";
import { Alert, AppState, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import {
  isFleetNotificationsEnabled,
  setFleetNotificationsEnabled,
} from "./meshFleetNotifications";

export function MeshFleetNotificationsToggle() {
  const gt = useGT();
  const [enabled, setEnabled] = useState(isFleetNotificationsEnabled);
  const [busy, setBusy] = useState(false);
  const label = gt("Notify me about fleet changes");
  const explanation = gt(
    "Allow Android notifications for machine outages, recoveries, fleet alerts, and device certificate problems.",
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Android Settings can change notification permission while the app is away
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setEnabled(isFleetNotificationsEnabled());
    });
    return () => subscription.remove();
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      setEnabled(
        await setFleetNotificationsEnabled(next, {
          title: label,
          message: explanation,
          buttonPositive: gt("Continue", { $context: "request Android notification permission" }),
        }),
      );
    } catch {
      Alert.alert(gt("Could not update fleet notifications."));
    }
    setBusy(false);
  }

  return (
    <View className="flex-row items-center gap-3 pb-4">
      <View className="flex-1 gap-1">
        <Text className="font-medium text-foreground">{label}</Text>
        <Text className="text-sm text-muted-foreground">{explanation}</Text>
      </View>
      <ThemedSwitch
        accessibilityLabel={label}
        accessibilityHint={explanation}
        value={enabled}
        disabled={busy}
        onValueChange={(next) => void toggle(next)}
      />
    </View>
  );
}
