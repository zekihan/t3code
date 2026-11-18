type EnrollmentProtection = "strongbox" | "tee" | "software" | "unknown";

/**
 * "reenroll": the hub refused the leaf (a superseded one, usually after a renewal whose reply was
 * lost). "expired": the certificate ran out. "key-missing": the Keystore no longer has the key.
 * All three need a new token.
 */
type EnrollmentState = "valid" | "expired" | "reenroll" | "key-missing";

export interface EnrollmentStatus {
  readonly identity: string;
  /** Epoch milliseconds. */
  readonly issuedAt: number;
  readonly notAfter: number;
  /** When the renewal window opens: 90 days before `notAfter`. */
  readonly renewAt: number;
  readonly state: EnrollmentState;
  readonly renewalDue: boolean;
  readonly protection: EnrollmentProtection;
  /** True when the key's bytes could be read out of the Keystore. They cannot. */
  readonly exportable: boolean;
  /** The key and certificate a renewal replaced, kept for a week. */
  readonly previous: { readonly notAfter: number; readonly keepUntil: number } | null;
  readonly caRevision: string | null;
  /** When the last renewal check ran; 0 when none has. */
  readonly lastCheckAt: number;
  readonly lastError: string | null;
}

export type RenewResult =
  | { readonly outcome: "renewed" | "not-due" | "throttled" | "not-enrolled" }
  | { readonly outcome: "failed"; readonly code: string; readonly message: string };

/** The Android native module. Errors it rejects carry a `code` from `EnrollCode`. */
export interface MeshEnrollmentNative {
  getEnrollment(): Promise<EnrollmentStatus | null>;
  enroll(identity: string, token: string): Promise<EnrollmentStatus>;
  renew(force: boolean): Promise<RenewResult>;
  remove(): Promise<void>;
  setMeshOrigins(origins: string[]): Promise<void>;
  addListener(name: "enrollmentChanged", listener: () => void): { remove(): void };
}

/** What a failed operation looks like to the screen. */
export interface EnrollmentFailure {
  readonly code: string;
  readonly title: string;
  readonly detail: string;
}
