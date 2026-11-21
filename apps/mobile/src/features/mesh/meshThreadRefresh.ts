import { connectionRoutes, routeHttpBaseUrl } from "@t3tools/client-runtime/connection";
import { subscribe } from "@t3tools/client-runtime/rpc";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import { ORCHESTRATION_V2_WS_METHODS, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentThreads } from "../../state/threads";
import { meshViewerOriginOf } from "./meshViewerUrl";

export const meshThreadOrigin = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const entry = get(environmentCatalog.catalogValueAtom).entries.get(environmentId);
    if (!entry) return null;
    for (const route of connectionRoutes(entry)) {
      const url = routeHttpBaseUrl(route);
      const origin = url === null ? null : meshViewerOriginOf(url);
      if (origin !== null && new URL(origin).port === "") return origin;
    }
    return null;
  }),
);

export const checkedThreadRefreshes = Atom.make<ReadonlyMap<string, number>>(new Map()).pipe(
  Atom.keepAlive,
);

export const meshThreadRefreshState = Atom.family(
  (stateAtom: ReturnType<typeof environmentThreads.stateAtom>) =>
    Atom.make((get) => {
      const current = get(stateAtom);
      const previous = Option.getOrNull(
        get.self<{
          readonly status: EnvironmentThreadStatus;
          readonly synchronizedAt: number | null;
        }>(),
      );
      if (!AsyncResult.isSuccess(current)) return previous;
      const { status } = current.value;
      const synchronizedAt =
        status === "live" && previous?.status === "synchronizing"
          ? current.timestamp
          : (previous?.synchronizedAt ?? null);
      if (previous?.status === status && previous.synchronizedAt === synchronizedAt) {
        return previous;
      }
      return { status, synchronizedAt };
    }),
);

export const checkThreadRefresh = createEnvironmentCommand(connectionAtomRuntime, {
  label: "mesh:check-thread-refresh",
  execute: Effect.fn("mesh.checkThreadRefresh")(function* (
    threadId: ThreadId,
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
  ) {
    const detail = environmentThreads.stateAtom(environmentId, threadId);
    const afterSequence = AsyncResult.getOrElse(registry.get(detail), () => null)?.sequence ?? 0;
    registry.refresh(detail);

    // A retained "live" view can appear before the server answers a restarted subscription.
    const refresh = Effect.gen(function* () {
      const confirmation = yield* subscribe(ORCHESTRATION_V2_WS_METHODS.subscribeThread, {
        threadId,
        afterSequence,
        requestCompletionMarker: true,
        acceptBoundedSnapshot: true,
      }).pipe(
        Stream.takeUntil((item) => item.kind === "synchronized"),
        Stream.runFold(
          () => ({ sequence: afterSequence, complete: false }),
          (state, item) => {
            switch (item.kind) {
              case "synchronized":
                return { ...state, complete: true };
              case "snapshot":
                return { ...state, sequence: item.snapshotSequence };
              default:
                return { ...state, sequence: Math.max(state.sequence, item.sequence) };
            }
          },
        ),
      );
      if (!confirmation.complete) return false;
      return yield* AtomRegistry.toStream(registry, detail).pipe(
        Stream.filter(
          (result) =>
            AsyncResult.isSuccess(result) &&
            result.value.status === "live" &&
            result.value.sequence >= confirmation.sequence,
        ),
        Stream.runHead,
        Effect.map(Option.isSome),
      );
    });
    return yield* refresh.pipe(
      Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
    );
  }),
});
