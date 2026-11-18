import { EmptyState } from "../../components/ui/EmptyState";
import { FilePreviewLoading } from "../files/FilePreviewFeedback";
import type { CertificateLocalUri } from "./useCertificateLocalUri";

/** Shown while a protected page downloads, or when it could not be downloaded. */
export function CertificateLocalUriState(props: {
  readonly state: Exclude<CertificateLocalUri["state"], "ready">;
}) {
  return props.state === "loading" ? (
    <FilePreviewLoading message="Preparing preview..." background="card" />
  ) : (
    <EmptyState
      title="Preview unavailable"
      detail="The file could not be downloaded with the client certificate."
    />
  );
}

/** MCP apps run inside a sandboxed iframe whose bridge needs the server's own document. */
export function McpAppUnavailable(props: { readonly server: string }) {
  return (
    <EmptyState
      title="App unavailable"
      detail={`The ${props.server} app cannot be shown on Android when this environment needs a client certificate.`}
      variant="plain"
    />
  );
}

/** Android runs the device and browser streams in their own process; this shows when that is off. */
export function StreamSurfaceUnavailable(props: { readonly compact?: boolean }) {
  return (
    <EmptyState
      title="Stream unavailable"
      detail={
        props.compact
          ? "Not available on this device."
          : "Streams are not available on this device. They need Android 11 or newer."
      }
      variant="plain"
    />
  );
}
