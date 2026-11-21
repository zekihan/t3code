import { useIsFocused } from "@react-navigation/native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";

import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { Notice } from "../../components/ui/Notice";
import { parseEnrollmentQr } from "./meshQrPayload";

export function MeshEnrollmentScanner(props: {
  readonly disabled: boolean;
  readonly onToken: (token: string) => void;
}) {
  const gt = useGT();
  const focused = useIsFocused();
  const [permission, requestPermission] = useCameraPermissions();
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const accepting = useRef(false);
  const active = open && focused && !props.disabled && permission?.granted === true;

  const close = () => {
    accepting.current = false;
    setOpen(false);
  };

  const toggle = async () => {
    if (open) {
      close();
      return;
    }

    const result = permission?.granted ? permission : await requestPermission();
    if (!result.granted) {
      if (!result.canAskAgain) {
        Dialog.alert(
          gt("Camera access needed"),
          gt("Camera access was denied for this app. Open Settings to enable it."),
          [
            { text: gt("Cancel"), style: "cancel" },
            { text: gt("Open Settings"), onPress: () => void Linking.openSettings() },
          ],
        );
      }
      return;
    }

    setInvalid(false);
    accepting.current = true;
    setOpen(true);
  };

  return (
    <>
      <View className="items-start">
        <Button
          tone="secondary"
          size="compact"
          label={open ? gt("Stop scanning") : gt("Scan")}
          disabled={props.disabled}
          onPress={() => void toggle()}
        />
      </View>
      {active ? (
        <View className="h-56 overflow-hidden rounded-2xl">
          <CameraView
            active
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => {
              if (!accepting.current) return;
              close();
              const token = parseEnrollmentQr(data);
              if (token) props.onToken(token);
              else setInvalid(true);
            }}
            style={StyleSheet.absoluteFill}
          />
        </View>
      ) : null}
      {invalid ? (
        <Notice
          tone="danger"
          icon="exclamationmark.triangle"
          message={gt("This QR code is not an enrollment code.")}
        />
      ) : null}
    </>
  );
}
