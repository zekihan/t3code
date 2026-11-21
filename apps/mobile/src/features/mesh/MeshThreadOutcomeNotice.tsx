import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { environmentThreads } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { directAvailable } from "./meshDirect";
import { shouldShowMeshThreadOutcome } from "./meshThreadOutcome";
import {
  checkedThreadRefreshes,
  checkThreadRefresh,
  meshThreadOrigin,
  meshThreadRefreshState,
} from "./meshThreadRefresh";
import { useMeshDirect } from "./useMeshDirect";

function rememberRefresh(previous: ReadonlyMap<string, number>, key: string, at: number) {
  return (previous.get(key) ?? 0) >= at ? previous : new Map(previous).set(key, at);
}

function ThreadOutcomeNotice({
  origin,
  threadRef,
}: {
  readonly origin: string;
  readonly threadRef: ScopedThreadRef;
}) {
  const gt = useGT();
  const { environmentId, threadId } = threadRef;
  const outcome = useMeshDirect(origin)?.unknownOutcome ?? null;
  const detailAtom = environmentThreads.stateAtom(environmentId, threadId);
  const detail = useAtomValue(meshThreadRefreshState(detailAtom));
  const checkRefresh = useAtomCommand(checkThreadRefresh, { reportFailure: false });
  const key = JSON.stringify([origin, threadKey(threadRef)]);
  const checkedRefresh = useAtomValue(checkedThreadRefreshes, (refreshes) => refreshes.get(key));
  const setCheckedRefreshes = useAtomSet(checkedThreadRefreshes);
  const [checking, setChecking] = useState(false);
  const synchronizedAt = detail?.synchronizedAt ?? null;
  const outcomeAt = outcome?.at ?? null;
  const refreshedAt = Math.max(checkedRefresh ?? 0, synchronizedAt ?? 0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persist the completed sync across thread navigation
  useEffect(() => {
    if (outcomeAt !== null && synchronizedAt !== null && synchronizedAt > outcomeAt) {
      setCheckedRefreshes((previous) => rememberRefresh(previous, key, synchronizedAt));
    }
  }, [key, outcomeAt, setCheckedRefreshes, synchronizedAt]);

  if (!shouldShowMeshThreadOutcome(outcome, refreshedAt || null)) return null;

  const refreshThread = async () => {
    const at = Date.now();
    setChecking(true);
    const result = await checkRefresh({ environmentId, input: threadId });
    setChecking(false);
    if (result._tag === "Success" && result.value) {
      setCheckedRefreshes((previous) => rememberRefresh(previous, key, at));
    }
  };

  return (
    <View className="gap-2 px-4 pb-3">
      <AppText
        textRole="footnote"
        className="text-danger-foreground"
        accessibilityLiveRegion="polite"
      >
        {gt("The last request may have reached the machine. Check the thread before resending.")}
      </AppText>
      <Button
        label={gt("Refresh thread")}
        size="compact"
        loading={checking}
        onPress={() => void refreshThread()}
      />
    </View>
  );
}

function MeshThreadOutcomeLoader({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const origin = useAtomValue(meshThreadOrigin(threadRef.environmentId));
  return origin === null ? null : (
    <ThreadOutcomeNotice
      key={threadKey(threadRef) + origin}
      origin={origin}
      threadRef={threadRef}
    />
  );
}

export function MeshThreadOutcomeNotice({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef | null;
}) {
  return directAvailable && threadRef !== null ? (
    <MeshThreadOutcomeLoader threadRef={threadRef} />
  ) : null;
}
