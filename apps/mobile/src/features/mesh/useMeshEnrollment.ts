import { useEffect, useState } from "react";

import * as enrollmentApi from "./meshEnrollment";
import type { EnrollmentFailure, EnrollmentStatus, RenewResult } from "./meshEnrollment.types";
import { describeEnrollmentFailure, renewNotice } from "./meshEnrollmentLogic";

export interface MeshEnrollmentApi {
  readonly available: boolean;
  readonly getEnrollment: () => Promise<EnrollmentStatus | null>;
  readonly enrollDevice: (identity: string, token: string) => Promise<EnrollmentStatus>;
  readonly renewEnrollment: (force: boolean) => Promise<RenewResult>;
  readonly removeEnrollment: () => Promise<void>;
  readonly onChanged: (listener: () => void) => { remove(): void };
}

const nativeEnrollmentApi: MeshEnrollmentApi = {
  available: enrollmentApi.enrollmentAvailable,
  getEnrollment: enrollmentApi.getEnrollment,
  enrollDevice: enrollmentApi.enrollDevice,
  renewEnrollment: enrollmentApi.renewEnrollment,
  removeEnrollment: enrollmentApi.removeEnrollment,
  onChanged: enrollmentApi.onEnrollmentChanged,
};

type EnrollmentBusy = "enroll" | "renew" | "remove" | null;

export interface MeshEnrollmentState {
  readonly available: boolean;
  /** False until the first read of the native state has finished. */
  readonly loaded: boolean;
  readonly status: EnrollmentStatus | null;
  readonly busy: EnrollmentBusy;
  readonly failure: EnrollmentFailure | null;
  /** What the last renewal or removal came to, shown until the next action. */
  readonly notice: string | null;
  readonly now: number;
}

const initialState = (api: MeshEnrollmentApi): MeshEnrollmentState => ({
  available: api.available,
  loaded: false,
  status: null,
  busy: null,
  failure: null,
  notice: null,
  now: Date.now(),
});

/**
 * The enrollment state for the Mesh screen: the identity's status, and the three things a person
 * can do with it. The native side owns the state; this re-reads it when the module says it
 * changed (renewals also run at app start and in the foreground, without the screen open).
 */
export function useMeshEnrollment(api: MeshEnrollmentApi = nativeEnrollmentApi) {
  const [state, setState] = useState<MeshEnrollmentState>(() => initialState(api));

  const read = () =>
    api.getEnrollment().then(
      (status) => setState((previous) => ({ ...previous, status, loaded: true, now: Date.now() })),
      (error: unknown) =>
        setState((previous) => ({
          ...previous,
          loaded: true,
          failure: describeEnrollmentFailure(error),
        })),
    );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the identity lives in the Android Keystore and native preferences; the effect reads it on open and when the module reports a change
  useEffect(() => {
    void read();
    const subscription = api.onChanged(() => void read());
    return () => subscription.remove();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- subscribe once per api
  }, [api]);

  // Promise callbacks, not try/catch: the React Compiler cannot compile closures over catch scopes.
  const run = <T>(busy: Exclude<EnrollmentBusy, null>, action: () => Promise<T>) => {
    setState((previous) => ({ ...previous, busy, failure: null, notice: null }));
    return action().then(
      (value) => {
        setState((previous) => ({ ...previous, busy: null }));
        return { ok: true as const, value };
      },
      (error: unknown) => {
        setState((previous) => ({
          ...previous,
          busy: null,
          failure: describeEnrollmentFailure(error),
        }));
        return { ok: false as const };
      },
    );
  };

  return {
    state,
    refresh: read,
    enroll: async (identity: string, token: string) => {
      const result = await run("enroll", () => api.enrollDevice(identity, token));
      if (result.ok) {
        setState((previous) => ({ ...previous, status: result.value, now: Date.now() }));
      }
      return result.ok;
    },
    renew: async () => {
      const result = await run("renew", () => api.renewEnrollment(true));
      if (!result.ok) return;
      const outcome = result.value;
      setState((previous) =>
        outcome.outcome === "failed"
          ? {
              ...previous,
              failure: describeEnrollmentFailure(
                Object.assign(new Error(outcome.message), { code: outcome.code }),
              ),
            }
          : { ...previous, notice: renewNotice(outcome) },
      );
      await read();
    },
    remove: async () => {
      const result = await run("remove", () => api.removeEnrollment());
      if (result.ok) {
        setState((previous) => ({ ...previous, status: null, notice: "Enrollment removed." }));
      }
    },
  };
}
