import { Button, Column, getMaterialColors, Spacer, Text } from "@expo/ui/jetpack-compose";
import { fillMaxSize, height, paddingAll } from "@expo/ui/jetpack-compose/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type { MeshWidgetSnapshot } from "./meshWidgetSnapshot";

export function MeshFleetWidget(props: MeshWidgetSnapshot, environment: WidgetEnvironment) {
  "widget";
  const mode = props.theme?.mode;
  const appearance =
    mode === "light" || mode === "dark"
      ? mode
      : environment.colorScheme === "dark"
        ? "dark"
        : "light";
  const palette = props.theme?.[appearance];
  const material = getMaterialColors({ scheme: appearance });
  const foreground = palette?.foreground ?? material.onSurface;
  const muted = palette?.secondary ?? material.onSurfaceVariant;
  const compact = (environment.height ?? 180) < 130;

  return (
    <Button
      colors={{ containerColor: palette?.background ?? material.surface }}
      modifiers={[fillMaxSize()]}
      onClick={() => {}}
    >
      <Column modifiers={[fillMaxSize(), paddingAll(compact ? 8 : 14)]}>
        <Text
          color={foreground}
          maxLines={1}
          style={{ fontSize: compact ? 16 : 23, fontWeight: "bold" }}
        >
          {/* oxlint-disable-next-line t3code/no-untranslated-copy -- widget fallback before the first localized snapshot */}
          {props.fleet ?? "Mesh fleet status"}
        </Text>
        <Spacer modifiers={[height(compact ? 2 : 6)]} />
        {props.path ? (
          <Text color={muted} maxLines={1} style={{ fontSize: 13 }}>
            {props.path}
          </Text>
        ) : null}
        {props.certificate ? (
          <Text
            color={props.certificateWarning ? (palette?.danger ?? material.error) : foreground}
            maxLines={1}
            style={{ fontSize: 13, fontWeight: props.certificateWarning ? "bold" : "normal" }}
          >
            {props.certificate}
          </Text>
        ) : null}
        <Spacer modifiers={[height(compact ? 2 : 6)]} />
        <Text color={muted} maxLines={1} style={{ fontSize: 11 }}>
          {/* oxlint-disable-next-line t3code/no-untranslated-copy -- widget fallback before the first localized snapshot */}
          {props.updated ?? "Open T3 Mesh to refresh"}
        </Text>
      </Column>
    </Button>
  );
}

export default createWidget("SubscriptionUsage", MeshFleetWidget);
