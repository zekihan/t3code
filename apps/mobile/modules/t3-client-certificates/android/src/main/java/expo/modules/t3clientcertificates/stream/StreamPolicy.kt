package expo.modules.t3clientcertificates.stream

import expo.modules.t3clientcertificates.certificateOrigin
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** The process name declared for [StreamService] in AndroidManifest.xml. */
internal const val STREAM_PROCESS_SUFFIX = ":stream"

/** WebView refuses a second process on the default data directory. */
internal const val STREAM_DATA_DIRECTORY_SUFFIX = "stream"

private const val DEFAULT_HTTPS_PORT = 443
private const val ABOUT_BLANK = "about:blank"

internal fun isStreamProcessName(processName: String?, packageName: String) =
  processName == packageName + STREAM_PROCESS_SUFFIX

internal sealed interface ClientCertificateDecision {
  data object Cancel : ClientCertificateDecision

  data class Proceed(val alias: String) : ClientCertificateDecision
}

/**
 * Answers a WebView client certificate request in the stream process. The environment's origin
 * and its stored alias come from the app process; every request for another host or port, or
 * from a surface without a stored alias, is cancelled.
 */
internal fun decideClientCertificate(
  environmentUrl: String?,
  alias: String?,
  requestHost: String?,
  requestPort: Int
): ClientCertificateDecision {
  val origin =
    environmentUrl?.let(::certificateOrigin)?.toHttpUrlOrNull()
      ?: return ClientCertificateDecision.Cancel
  val host = requestHost?.let(::canonicalHost)
  // Chromium reports the port it connected to; -1 would mean the scheme default.
  val port = if (requestPort <= 0) DEFAULT_HTTPS_PORT else requestPort
  return if (alias.isNullOrEmpty() || host != origin.host || port != origin.port) {
    ClientCertificateDecision.Cancel
  } else {
    ClientCertificateDecision.Proceed(alias)
  }
}

private fun canonicalHost(host: String) =
  host.removePrefix("[").removeSuffix("]").trimEnd('.').lowercase()

/** The stream page is a single synthetic document; it never navigates anywhere else. */
internal fun navigationAllowed(url: String, baseUrl: String) = url == ABOUT_BLANK || url == baseUrl
