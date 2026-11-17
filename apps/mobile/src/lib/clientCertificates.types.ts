export interface ClientCertificateSubscription {
  remove(): void;
}

export interface ClientCertificateTransferInput {
  readonly url: string;
  readonly fileUri: string;
  readonly upload?: boolean;
  readonly contentType?: string;
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: number) => void;
}

/** `notAfter` is the leaf certificate's expiry in epoch milliseconds. */
export interface ClientCertificateStatus {
  readonly state: "valid" | "expired" | "invalid" | "missing";
  readonly notAfter: number | null;
}

export interface ClientCertificateIdentityProblem {
  readonly origin: string;
  readonly reason: ClientCertificateStatus["state"];
}
