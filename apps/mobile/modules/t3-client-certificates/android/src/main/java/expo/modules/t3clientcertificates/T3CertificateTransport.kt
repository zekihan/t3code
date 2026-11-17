package expo.modules.t3clientcertificates

import android.content.Context
import android.security.KeyChain
import android.security.KeyChainException
import com.facebook.react.modules.network.CustomClientBuilder
import com.facebook.react.modules.network.NetworkingModule
import com.facebook.react.modules.websocket.WebSocketModule
import java.io.IOException
import java.net.Socket
import java.security.KeyStore
import java.security.PrivateKey
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient

/**
 * Process-wide transport, installed before React Native, Expo fetch, or Fresco creates a client.
 */
class T3CertificateTransport private constructor(private val context: Context) {
  internal val lock = Any()
  internal val preferences =
    context.getSharedPreferences("t3-client-certificates", Context.MODE_PRIVATE)
  internal val calls = ConcurrentHashMap<String, Call>()
  internal val sockets = ConcurrentHashMap<Socket, String>()

  // Accessed only under lock. Tokens distinguish remove/re-add and same-alias replacement.
  private val generations = CertificateGenerations()
  private val trust: X509TrustManager
  private val defaultTls: SSLContext
  private val socketFactory: SSLSocketFactory
  internal val fileClient: OkHttpClient
  private val providerFactory = ProviderFactoryGuard(::configure)

  // React Native, Expo fetch and Fresco each build their own client. One pool lets a changed
  // identity drop every idle connection they hold.
  private val connectionPool = ConnectionPool()

  /** Called off the main thread when a stored alias cannot be used; `reason` is a status state. */
  @Volatile internal var identityProblem: ((origin: String, reason: String) -> Unit)? = null

  init {
    val trustFactory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    trustFactory.init(null as KeyStore?)
    trust = trustFactory.trustManagers.filterIsInstance<X509TrustManager>().single()
    defaultTls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
    socketFactory =
      OriginSocketFactory(
        defaultTls.socketFactory,
        ::identityFactory,
        { origin, socket ->
          sockets.entries.removeIf { it.key.isClosed }
          sockets[socket] = origin
        },
        lock,
        ::generation
      )
    providerFactory.install()
    val customize = CustomClientBuilder { builder -> configure(builder) }
    NetworkingModule.setCustomClientBuilder(customize)
    WebSocketModule.setCustomClientBuilder(customize)
    fileClient =
      configure(OkHttpClient.Builder())
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()
  }

  internal fun generation(origin: String): Any = generations.generation(origin)

  internal fun invalidate(origin: String) {
    generations.invalidate(origin)
  }

  internal fun invalidateAll() {
    generations.invalidateAll()
  }

  internal fun evictConnections() {
    connectionPool.evictAll()
  }

  private class LoadedIdentity(val key: PrivateKey?, val chain: Array<X509Certificate>?)

  // KeyChain blocks on another process: never call from the main thread.
  private fun loadIdentity(alias: String): LoadedIdentity =
    try {
      LoadedIdentity(
        KeyChain.getPrivateKey(context, alias),
        KeyChain.getCertificateChain(context, alias)
      )
    } catch (_: KeyChainException) {
      LoadedIdentity(null, null)
    }

  internal fun inspect(alias: String): CertificateStatus =
    loadIdentity(alias).let { certificateStatus(it.chain, it.key != null) }

  @Suppress("TooGenericExceptionCaught") // Any KeyChain or TLS setup failure fails the connection.
  private fun identityFactory(origin: String): SSLSocketFactory {
    val alias = preferences.getString(origin, null) ?: return defaultTls.socketFactory
    return try {
      val identity = loadIdentity(alias)
      val status = certificateStatus(identity.chain, identity.key != null)
      val key = identity.key
      val chain = identity.chain
      if (!status.usable || key == null || chain == null) unusable(origin, alias, status)
      // Resolve the KeyChain grant on each new connection. No exported keys or TLS session
      // resumption across a removed/replaced identity.
      SSLContext
        .getInstance("TLS")
        .apply { init(arrayOf(SelectedIdentity(alias, key, chain)), arrayOf(trust), null) }
        .socketFactory
    } catch (error: Exception) {
      throw error as? IOException
        ?: IOException("Client certificate '$alias' could not be used: ${error.message}", error)
    }
  }

  private fun unusable(origin: String, alias: String, status: CertificateStatus): Nothing {
    identityProblem?.invoke(origin, status.state)
    throw IOException(
      "Client certificate '$alias' is ${status.state}. Select it again in Connections."
    )
  }

  private fun configure(builder: OkHttpClient.Builder): OkHttpClient.Builder =
    builder
      .sslSocketFactory(socketFactory, trust)
      .hostnameVerifier(originHostnameVerifier)
      .connectionPool(connectionPool)

  companion object {
    @Volatile private var instance: T3CertificateTransport? = null

    @JvmStatic
    @Synchronized
    fun install(context: Context): T3CertificateTransport =
      instance ?: T3CertificateTransport(context.applicationContext).also { instance = it }

    /** Runs at the end of Application.onCreate, after every library's start-up hook. */
    @JvmStatic
    @Synchronized
    fun reassert() {
      checkNotNull(instance) { "Client certificate transport was not installed" }
        .providerFactory
        .reassert()
    }
  }
}
