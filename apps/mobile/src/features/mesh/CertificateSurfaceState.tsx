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

/** The device and browser streams run a WebView script against the server. */
export function StreamSurfaceUnavailable(props: { readonly compact?: boolean }) {
  return (
    <EmptyState
      title="Stream unavailable"
      detail={
        props.compact
          ? "Not available on Android yet."
          : "Streams are not available on Android yet because a WebView cannot present your client certificate."
      }
      variant="plain"
    />
  );
}
