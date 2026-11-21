import { useFocusEffect } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { clientCertificatesAvailable } from "../../lib/clientCertificates";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { unpairedMeshMachines } from "./meshEnvironments";
import type { MeshMachine } from "./meshMachines";
import { loadCachedMeshMachines } from "./meshStore";
import { useMeshPairing } from "./useMeshPairing";

/** `inList` places it above the thread list instead of in the empty state. */
export function MeshHomeMachines(props: { readonly inList?: boolean }) {
  return clientCertificatesAvailable ? <CachedMeshHomeMachines inList={props.inList} /> : null;
}

function CachedMeshHomeMachines(props: { readonly inList?: boolean | undefined }) {
  const [machines, setMachines] = useState<readonly MeshMachine[] | null>(null);
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const pair = useMeshPairing("home");

  useFocusEffect(
    useCallback(() => {
      let focused = true;
      void loadCachedMeshMachines().then((cached) => {
        if (focused) setMachines(cached?.machines ?? null);
      });
      return () => {
        focused = false;
      };
    }, []),
  );

  return (
    <MeshHomeMachinesList
      machines={unpairedMeshMachines(machines, connectedEnvironments)}
      onPair={pair}
      inList={props.inList}
    />
  );
}

export function MeshHomeMachinesList(props: {
  readonly machines: readonly MeshMachine[];
  readonly onPair: (machine: MeshMachine) => void;
  readonly inList?: boolean | undefined;
}) {
  const gt = useGT();
  if (props.machines.length === 0) return null;

  return (
    <View className={props.inList ? "gap-2 px-4 pb-3" : "mt-4 gap-2"}>
      <Text className="text-sm font-semibold text-foreground">{gt("Unpaired mesh machines")}</Text>
      {props.machines.map((machine) => (
        <View key={machine.name} className="flex-row items-center justify-between gap-2">
          <Text className="flex-1 text-sm text-foreground">{machine.name}</Text>
          <Button
            size="compact"
            tone="secondary"
            label={gt("Pair", { $context: "verb, pairs a machine" })}
            accessibilityLabel={gt("Pair {name}", { name: machine.name })}
            onPress={() => props.onPair(machine)}
          />
        </View>
      ))}
    </View>
  );
}
