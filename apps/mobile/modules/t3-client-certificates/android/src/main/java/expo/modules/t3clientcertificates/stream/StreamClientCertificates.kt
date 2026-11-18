package expo.modules.t3clientcertificates.stream

import android.content.Context
import android.security.KeyChain
import android.webkit.ClientCertRequest
import expo.modules.t3clientcertificates.certificateStatus
import expo.modules.t3clientcertificates.enroll.AndroidKeystoreBackend
import expo.modules.t3clientcertificates.enroll.expiryState
import expo.modules.t3clientcertificates.enroll.isEnrolledAlias
import expo.modules.t3clientcertificates.enroll.parseCertificates
import java.util.concurrent.Executors

/**
 * Answers a stream WebView's client certificate requests. Only the environment the session was
 * opened for gets the stored alias's certificate; everything else is cancelled, and the app
 * process's own WebViews never reach this code.
 */
internal class StreamClientCertificates(
  private val context: Context,
  private val environmentUrl: String?,
  private val alias: String?,
  private val enrolled: StreamEnrolledIdentity? = null
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

  // Any KeyChain or Keystore failure must still answer the request.
  @Suppress("TooGenericExceptionCaught")
  private fun proceed(alias: String, request: ClientCertRequest) {
    try {
      when (val source = credentialSource(alias, enrolled)) {
        CredentialSource.None -> request.cancel()
        is CredentialSource.KeyChain -> proceedWithKeyChain(source.alias, request)
        is CredentialSource.Keystore -> proceedWithKeystore(source.identity, request)
      }
    } catch (_: Exception) {
      request.cancel()
    }
  }

  private fun proceedWithKeyChain(alias: String, request: ClientCertRequest) {
    val key = KeyChain.getPrivateKey(context, alias)
    val chain = KeyChain.getCertificateChain(context, alias)
    if (key != null && chain != null && certificateStatus(chain, true).usable) {
      request.proceed(key, chain)
    } else {
      request.cancel()
    }
  }

  // The enrolled key lives in the Android Keystore, which every process of this app can reach.
  private fun proceedWithKeystore(identity: StreamEnrolledIdentity, request: ClientCertRequest) {
    val key = AndroidKeystoreBackend(context).privateKey(identity.keystoreAlias)
    val chain = parseCertificates(identity.chainPem).toTypedArray()
    val usable = chain.isNotEmpty() && expiryState(chain, System.currentTimeMillis()) == "valid"
    if (key != null && usable) request.proceed(key, chain) else request.cancel()
  }
}

/** The enrolled identity as the app process hands it over: a Keystore alias and the certificates. */
internal class StreamEnrolledIdentity(val keystoreAlias: String, val chainPem: String)

/** Where a stream session gets the key for the alias it was opened with. */
internal sealed interface CredentialSource {
  data object None : CredentialSource

  data class KeyChain(val alias: String) : CredentialSource

  data class Keystore(val identity: StreamEnrolledIdentity) : CredentialSource
}

/**
 * An enrolled alias is only ever answered from the Keystore; with no Keystore identity in the
 * request it is answered with nothing. KeyChain is asked only about aliases the person chose.
 */
internal fun credentialSource(alias: String, enrolled: StreamEnrolledIdentity?): CredentialSource =
  when {
    !isEnrolledAlias(alias) -> CredentialSource.KeyChain(alias)
    enrolled != null -> CredentialSource.Keystore(enrolled)
    else -> CredentialSource.None
  }
