import type { EnrollmentStatus, RenewResult } from "./meshEnrollment.types";

// Device enrollment is Android-only (meshEnrollment.android.ts).
const unsupported = () =>
  Promise.reject(new Error("Device enrollment is only supported on Android."));

export const enrollmentAvailable = false;
export const getEnrollment = (): Promise<EnrollmentStatus | null> => Promise.resolve(null);
export const enrollDevice = (_identity: string, _token: string): Promise<EnrollmentStatus> =>
  unsupported();
export const renewEnrollment = (_force: boolean): Promise<RenewResult> => unsupported();
export const removeEnrollment = (): Promise<void> => unsupported();
export const setMeshOrigins = (_origins: readonly string[]): Promise<void> => Promise.resolve();
export const onEnrollmentChanged = (_listener: () => void): { remove(): void } => ({
  remove() {},
});
