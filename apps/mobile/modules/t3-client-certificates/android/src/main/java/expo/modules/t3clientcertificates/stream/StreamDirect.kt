package expo.modules.t3clientcertificates.stream

import android.net.http.SslCertificate
import android.os.Bundle
import android.util.Log
import android.webkit.SslErrorHandler
import android.net.http.SslError
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import expo.modules.t3clientcertificates.direct.AgentCheck
import expo.modules.t3clientcertificates.direct.AgentCheckResult
import java.security.cert.X509Certificate
import java.util.concurrent.Executor

private const val TAG = "T3MeshStream"

/**
 * What a stream needs to take the direct path (A8): the app's loopback proxy that checks the
 * peer first, the environment's host, and what the same agent check needs.
 */
internal class DirectStream(
  val proxyPort: Int,
  val host: String,
  val caBundlePem: String,
  val revoked: List<String>,
  val agentIdentity: String
) {
  fun putInto(bundle: Bundle) {
    bundle.putInt(StreamProtocol.DIRECT_PORT, proxyPort)
    bundle.putString(StreamProtocol.DIRECT_HOST, host)
    bundle.putString(StreamProtocol.DIRECT_CA, caBundlePem)
    bundle.putStringArray(StreamProtocol.DIRECT_REVOKED, revoked.toTypedArray())
    bundle.putString(StreamProtocol.DIRECT_IDENTITY, agentIdentity)
  }

  companion object {
    fun from(data: Bundle): DirectStream? {
      val port = data.getInt(StreamProtocol.DIRECT_PORT, 0)
      val host = data.getString(StreamProtocol.DIRECT_HOST)
      val ca = data.getString(StreamProtocol.DIRECT_CA)
      val identity = data.getString(StreamProtocol.DIRECT_IDENTITY)
      val revoked = data.getStringArray(StreamProtocol.DIRECT_REVOKED)?.toList().orEmpty()
      return if (port > 0 && host != null && ca != null) {
        identity?.let { DirectStream(port, host, ca, revoked, it) }
      } else {
        null
      }
    }
  }
}

/**
 * The stream process's decision about a certificate the WebView could not validate itself: the agent
 * of the machine the stream is for presents one that passes the same agent check as the app's own
 * connections, on exactly that host. Anything else is refused.
 */
internal class DirectStreamPolicy(private val direct: DirectStream) {
  private val check = AgentCheck(direct.caBundlePem, direct.revoked.toSet(), direct.agentIdentity)

  fun accepts(url: String?, certificate: X509Certificate?): Boolean {
    val host =
      try {
        url?.let { java.net.URI(it).host?.lowercase() }
      } catch (_: java.net.URISyntaxException) {
        null
      }
    if (host != direct.host || certificate == null) return false
    return check.check(listOf(certificate)) is AgentCheckResult.Accepted
  }

  /** Answers [handler] for [error]: proceed for the machine's agent, cancel otherwise. */
  fun answer(handler: SslErrorHandler, error: SslError) {
    val certificate: SslCertificate? = error.certificate
    if (accepts(error.url, certificate?.x509Certificate)) handler.proceed() else handler.cancel()
  }
}

/**
 * Points the WebViews of the stream process at the app's checking proxy, for the hosts of the
 * streams that take the direct path and for no other host. The setting is process-wide, so it is
 * re-applied with every direct host whenever one stream starts or ends.
 */
internal object StreamProxy {
  private val sessions = LinkedHashMap<String, Pair<String, Int>>()

  /** Applies the override for [host]; [ready] runs once the WebView has taken it (or cannot). */
  fun add(session: String, host: String, port: Int, executor: Executor, ready: Runnable) {
    sessions[session] = host to port
    apply(executor, ready)
  }

  fun remove(session: String, executor: Executor) {
    if (sessions.remove(session) == null) return
    if (sessions.isEmpty()) {
      if (supported()) ProxyController.getInstance().clearProxyOverride(executor) {}
    } else {
      apply(executor) {}
    }
  }

  private fun supported() =
    WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE_REVERSE_BYPASS)

  private fun apply(executor: Executor, ready: Runnable) {
    if (!supported()) {
      Log.w(TAG, "The WebView cannot route one host through a proxy; streams use the viewer host.")
      ready.run()
      return
    }
    // One proxy for every direct stream: the app's listener that checks the peer before relaying.
    val port = sessions.values.first().second
    val config =
      ProxyConfig.Builder()
        .addProxyRule("http://127.0.0.1:$port")
        .apply { sessions.values.map { it.first }.toSet().forEach { addBypassRule(it) } }
        .setReverseBypassEnabled(true)
        .build()
    ProxyController.getInstance().setProxyOverride(config, executor, ready)
  }
}
