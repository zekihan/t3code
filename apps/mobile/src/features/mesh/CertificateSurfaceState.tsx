import { useGT } from "gt-react-native";

import { EmptyState } from "../../components/ui/EmptyState";
import { FilePreviewLoading } from "../files/FilePreviewFeedback";
import type { CertificateLocalUri } from "./useCertificateLocalUri";

/** Shown while a protected page downloads, or when it could not be downloaded. */
export function CertificateLocalUriState(props: {
  readonly state: Exclude<CertificateLocalUri["state"], "ready">;
}) {
  const gt = useGT();
  return props.state === "loading" ? (
    <FilePreviewLoading message={gt("Preparing preview...")} background="card" />
  ) : (
    <EmptyState
      title={gt("Preview unavailable")}
      detail={gt("The file could not be downloaded with the client certificate.")}
    />
  );
}

/** MCP apps run inside a sandboxed iframe whose bridge needs the server's own document. */
export function McpAppUnavailable(props: { readonly server: string }) {
  const gt = useGT();
  return (
    <EmptyState
      title={gt("App unavailable")}
      detail={gt(
        "The {server} app cannot be shown on Android when this environment needs a client certificate.",
        { server: props.server },
      )}
      variant="plain"
    />
  );
}

/** Android runs the device and browser streams in their own process; this shows when that is off. */
export function StreamSurfaceUnavailable(props: { readonly compact?: boolean }) {
  const gt = useGT();
  return (
    <EmptyState
      title={gt("Stream unavailable")}
      detail={
        props.compact
          ? gt("Not available on this device.")
          : gt("Streams are not available on this device. They need Android 11 or newer.")
      }
      variant="plain"
    />
  );
}
