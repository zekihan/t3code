package expo.modules.t3clientcertificates.stream

import android.content.Context
import android.security.KeyChain
import android.webkit.ClientCertRequest
import expo.modules.t3clientcertificates.certificateStatus
import java.util.concurrent.Executors

/**
 * Answers a stream WebView's client certificate requests. Only the environment the session was
 * opened for gets the stored alias's certificate; everything else is cancelled, and the app
 * process's own WebViews never reach this code.
 */
internal class StreamClientCertificates(
  private val context: Context,
  private val environmentUrl: String?,
  private val alias: String?
) {
  // KeyChain blocks on another process, so it never runs on the WebView's thread.
  private val io = Executors.newSingleThreadExecutor()

  fun respond(request: ClientCertRequest) {
    when (
      val decision = decideClientCertificate(environmentUrl, alias, request.host, request.port)
    ) {
      ClientCertificateDecision.Cancel -> request.cancel()
      is ClientCertificateDecision.Proceed -> io.execute { proceed(decision.alias, request) }
    }
  }

  fun shutdown() {
    io.shutdownNow()
  }

  @Suppress("TooGenericExceptionCaught") // Any KeyChain failure must still answer the request.
  private fun proceed(alias: String, request: ClientCertRequest) {
    try {
      val key = KeyChain.getPrivateKey(context, alias)
      val chain = KeyChain.getCertificateChain(context, alias)
      if (key != null && chain != null && certificateStatus(chain, true).usable) {
        request.proceed(key, chain)
      } else {
        request.cancel()
      }
    } catch (_: Exception) {
      request.cancel()
    }
  }
}
