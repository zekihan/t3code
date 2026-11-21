package expo.modules.t3clientcertificates

import java.io.IOException
import java.net.InetAddress
import java.net.Socket
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.CertificateExpiredException
import java.security.cert.CertificateNotYetValidException
import java.security.cert.X509Certificate
import java.util.Date
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509ExtendedKeyManager
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import okhttp3.OkHttpClient

/** HTTPS and WSS share an identity; paths, credentials and fragments never enter the key. */
internal fun certificateOrigin(url: String): String? {
  val normalized = if (url.startsWith("wss://", true)) "https://" + url.substring(6) else url
  val parsed =
    normalized
      .toHttpUrlOrNull()
      ?.takeIf { it.scheme == "https" && it.username.isEmpty() && it.password.isEmpty() }
      ?: return null
  return parsed.newBuilder().encodedPath("/").query(null).fragment(null).build().toString()
}

/** What the app sees of a stored alias. `notAfter` is the leaf certificate's expiry in epoch ms. */
internal data class CertificateStatus(val state: String, val notAfter: Long?) {
  val usable get() = state == "valid"
}

/** Missing keys and chains mean the KeyChain entry is gone or no longer granted to this app. */
internal fun certificateStatus(
  chain: Array<X509Certificate>?,
  hasKey: Boolean,
  now: Date = Date()
): CertificateStatus {
  val leaf = chain?.firstOrNull()
  if (!hasKey || leaf == null) return CertificateStatus("missing", null)
  val notAfter = leaf.notAfter.time
  val state =
    try {
      chain.forEach { it.checkValidity(now) }
      "valid"
    } catch (_: CertificateExpiredException) {
      "expired"
    } catch (_: CertificateNotYetValidException) {
      "invalid"
    }
  return CertificateStatus(state, notAfter)
}

internal class SelectedIdentity(
  private val alias: String,
  private val key: PrivateKey,
  private val chain: Array<X509Certificate>
) : X509ExtendedKeyManager() {
  private fun accepts(types: Array<out String>?, issuers: Array<out Principal>?): Boolean {
    val keyType = types?.any { it.substringBefore('_').equals(key.algorithm, true) } == true
    return keyType && (issuers.isNullOrEmpty() || issuedBy(issuers))
  }

  private fun issuedBy(issuers: Array<out Principal>) =
    chain.any { cert -> issuers.any { it == cert.issuerX500Principal } }

  override fun chooseClientAlias(
    types: Array<out String>?,
    issuers: Array<out Principal>?,
    socket: Socket?
  ) = if (accepts(types, issuers)) alias else null

  override fun chooseEngineClientAlias(
    types: Array<out String>?,
    issuers: Array<out Principal>?,
    engine: SSLEngine?
  ) = if (accepts(types, issuers)) alias else null

  override fun getClientAliases(type: String?, issuers: Array<out Principal>?) =
    if (type != null && accepts(arrayOf(type), issuers)) arrayOf(alias) else null

  override fun getPrivateKey(requestedAlias: String?) =
    if (requestedAlias == alias) key else null

  override fun getCertificateChain(requestedAlias: String?) =
    if (requestedAlias == alias) chain.clone() else null

  override fun chooseServerAlias(
    type: String?,
    issuers: Array<out Principal>?,
    socket: Socket?
  ): String? = null

  override fun getServerAliases(type: String?, issuers: Array<out Principal>?): Array<String>? =
    null
}

/**
 * Identity changes invalidate queued work even when the selected alias stays the same.
 * Callers hold the transport lock while capturing, checking, or invalidating tokens.
 */
internal class CertificateGenerations {
  private val tokens = mutableMapOf<String, Any>()

  fun generation(origin: String): Any = tokens.getOrPut(origin) { Any() }

  fun invalidate(origin: String) {
    tokens.remove(origin)
  }

  fun invalidateAll() {
    tokens.clear()
  }
}

// OkHttp permits HTTP/2 connection coalescing across hosts only with its own verifier instance.
// Delegating the same checks preserves HTTP/2 within an origin without sharing its client identity.
internal val originHostnameVerifier: HostnameVerifier =
  OkHttpClient().hostnameVerifier.let { verifier ->
    HostnameVerifier { host, session -> verifier.verify(host, session) }
  }

/** Select using OkHttp's original hostname, never reverse DNS or the resolved IP address. */
internal class OriginSocketFactory(
  private val fallback: SSLSocketFactory,
  private val factory: (String) -> SSLSocketFactory,
  private val opened: (String, Socket) -> Unit,
  private val lock: Any = Any(),
  private val generation: (String) -> Any? = { null },
  /** A factory for a connection that came through the direct path's proxy, else null. */
  private val direct: (String, Socket) -> SSLSocketFactory? = { _, _ -> null }
) : SSLSocketFactory() {
  override fun getDefaultCipherSuites(): Array<String> = fallback.defaultCipherSuites

  override fun getSupportedCipherSuites(): Array<String> = fallback.supportedCipherSuites

  override fun createSocket(socket: Socket, host: String, port: Int, autoClose: Boolean): Socket {
    val authority = if (host.contains(':')) "[$host]" else host
    val origin = requireNotNull(certificateOrigin("https://$authority:$port"))
    val expectedGeneration = synchronized(lock) { generation(origin) }
    // KeyChain may wait on another process. Neither other hosts nor certificate removal should
    // wait for that work; reject its result if the identity changed while it was being resolved.
    val selected = direct(origin, socket) ?: factory(origin)
    return synchronized(lock) {
      if (generation(origin) !== expectedGeneration) {
        throw IOException("Certificate selection changed. Try again.")
      }
      selected.createSocket(socket, host, port, autoClose).also { opened(origin, it) }
    }
  }

  // OkHttp uses the layered overload. Refuse ambiguous forms instead of guessing a destination.
  override fun createSocket(host: String, port: Int): Socket =
    throw UnsupportedOperationException("Layered TLS required")

  override fun createSocket(
    host: String,
    port: Int,
    local: InetAddress,
    localPort: Int
  ): Socket = throw UnsupportedOperationException("Layered TLS required")

  override fun createSocket(host: InetAddress, port: Int): Socket =
    throw UnsupportedOperationException("Hostname required")

  override fun createSocket(
    host: InetAddress,
    port: Int,
    local: InetAddress,
    localPort: Int
  ): Socket = throw UnsupportedOperationException("Hostname required")
}

/**
 * Keeps React Native's client factory presenting the identity. Other libraries replace that factory
 * from their own start-up hooks (expo-app-metrics does, after ours, from Expo's lifecycle
 * dispatcher), which would silently drop the client certificate. [reassert] wraps whatever factory
 * replaced ours, so its interceptors stay and the TLS configuration is ours again.
 */
internal class ProviderFactoryGuard(
  private val configure: (OkHttpClient.Builder) -> OkHttpClient.Builder
) {
  @Volatile private var delegate: OkHttpClientFactory? = null

  // Networking and Fresco must not open separate caches over the same directory.
  val factory = OkHttpClientFactory {
    configure(
      delegate?.createNewNetworkModuleClient()?.newBuilder()
        ?: OkHttpClientProvider.createClientBuilder()
    ).build()
  }

  fun install() = OkHttpClientProvider.setOkHttpClientFactory(factory)

  fun isInstalled() = currentProviderFactory() === factory

  fun reassert() {
    val current = currentProviderFactory()
    if (current !== factory) {
      delegate = current
      install()
    }
  }
}

/** The provider has no getter. Unreadable means unknown: [ProviderFactoryGuard] then replaces it. */
internal fun currentProviderFactory(): OkHttpClientFactory? =
  try {
    OkHttpClientProvider::class.java
      .getDeclaredField("factory")
      .apply { isAccessible = true }
      .get(OkHttpClientProvider) as? OkHttpClientFactory
  } catch (_: ReflectiveOperationException) {
    null
  }
