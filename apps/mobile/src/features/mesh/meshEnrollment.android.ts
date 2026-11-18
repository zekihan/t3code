import { requireOptionalNativeModule } from "expo";

import type { MeshEnrollmentNative } from "./meshEnrollment.types";

// The module lives in modules/t3-client-certificates, next to the transport that uses the identity.
const native = requireOptionalNativeModule<MeshEnrollmentNative>("T3MeshEnrollment");
const missing = () =>
  Promise.reject(new Error("Device enrollment requires the Android custom build."));

export const enrollmentAvailable = native !== null;
export const getEnrollment = () => (native ? native.getEnrollment() : Promise.resolve(null));
export const enrollDevice = (identity: string, token: string) =>
  native ? native.enroll(identity, token) : missing();
export const renewEnrollment = (force: boolean) => (native ? native.renew(force) : missing());
export const removeEnrollment = () => (native ? native.remove() : missing());
/** Tells the transport which viewer origins the hub listed; they use the enrolled identity. */
export const setMeshOrigins = (origins: readonly string[]) =>
  native ? native.setMeshOrigins([...origins]) : Promise.resolve();
export const onEnrollmentChanged = (listener: () => void) =>
  native?.addListener("enrollmentChanged", listener) ?? { remove() {} };
