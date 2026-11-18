package expo.modules.t3clientcertificates

import android.content.Context
import android.security.KeyChain
import android.security.KeyChainException
import com.facebook.react.modules.network.CustomClientBuilder
import com.facebook.react.modules.network.NetworkingModule
import com.facebook.react.modules.websocket.WebSocketModule
import expo.modules.t3clientcertificates.enroll.AndroidKeystoreBackend
import expo.modules.t3clientcertificates.enroll.ENROLLMENT_PREFERENCES
import expo.modules.t3clientcertificates.enroll.EnrolledUnavailable
import expo.modules.t3clientcertificates.enroll.EnrollmentClient
import expo.modules.t3clientcertificates.enroll.EnrollmentManager
import expo.modules.t3clientcertificates.enroll.OriginIdentities
import expo.modules.t3clientcertificates.enroll.PreferencesEnrollmentStorage
import expo.modules.t3clientcertificates.enroll.RenewalClient
import expo.modules.t3clientcertificates.enroll.enrolledAlias
import expo.modules.t3clientcertificates.enroll.isEnrolledAlias
import expo.modules.t3clientcertificates.enroll.isMeshOrigin
import expo.modules.t3clientcertificates.enroll.sanitizeMeshOrigins
import expo.modules.t3clientcertificates.stream.StreamEnrolledIdentity
import expo.modules.t3clientcertificates.stream.StreamProcess
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

  /** Called when the identity an origin uses changed, so the app can read it again. */
  @Volatile internal var originChanged: ((origin: String) -> Unit)? = null

  /** Called when the enrollment's status changed, whether or not the identity did. */
  @Volatile internal var enrollmentStatusChanged: (() -> Unit)? = null

  internal val enrollmentStorage =
    PreferencesEnrollmentStorage(
      context.getSharedPreferences(ENROLLMENT_PREFERENCES, Context.MODE_PRIVATE)
    )

  /** The Keystore identity mesh origins use once the device is enrolled. */
  internal val enrollment =
    EnrollmentManager(
      keys = AndroidKeystoreBackend(context),
      storage = enrollmentStorage,
      enroller = EnrollmentClient(),
      renewer = { RenewalClient(renewalClient()) },
      onChanged = ::enrollmentChanged
    )

  // The Mesh screen's list of viewer origins, read on every connection; replaced as a whole.
  @Volatile private var listedMeshOrigins: Set<String>? = null

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

  // The hub may take a while to issue the certificate; the connection pool is shared.
  private fun renewalClient() = fileClient.newBuilder().readTimeout(
    RENEW_TIMEOUT_SECONDS,
    TimeUnit.SECONDS
  ).build()

  private fun meshOrigins(): Set<String> =
    listedMeshOrigins ?: enrollmentStorage.meshOrigins().also { listedMeshOrigins = it }

  private fun isMesh(origin: String) =
    isMeshOrigin(origin, meshOrigins()) { preferences.contains(meshMarker(it)) }

  /** True when [origin] presents the enrolled Keystore identity, never a KeyChain one. */
  internal fun usesEnrolledIdentity(origin: String) = enrollment.isEnrolled() && isMesh(origin)

  /**
   * The identity name reported for [origin]: the enrolled one for a mesh origin once enrolled,
   * otherwise the KeyChain alias the person chose or the Mesh screen assigned.
   */
  internal fun aliasFor(origin: String): String? =
    if (usesEnrolledIdentity(origin)) {
      enrollment.state()?.let { enrolledAlias(it.current.identity) }
    } else {
      preferences.getString(origin, null)
    }

  /** What the stream process needs to present the enrolled identity named by [alias], if it is. */
  internal fun enrolledStreamIdentity(alias: String): StreamEnrolledIdentity? =
    if (isEnrolledAlias(alias)) {
      enrollment.state()?.current?.let { StreamEnrolledIdentity(it.alias, it.chainPem) }
    } else {
      null
    }

  /** Replaces the viewer origins that use the enrolled identity; changed ones reconnect. */
  internal fun setMeshOrigins(origins: Collection<String>) {
    val next = sanitizeMeshOrigins(origins)
    val changed =
      synchronized(lock) {
        val before = meshOrigins()
        if (before == next) return
        enrollmentStorage.saveMeshOrigins(next)
        listedMeshOrigins = next
        (before + next) - (before intersect next)
      }
    if (!enrollment.isEnrolled()) return
    changed.forEach {
      synchronized(lock) { retire(it) }
      originChanged?.invoke(it)
    }
  }

  /** The enrolled identity changed: every connection may hold the old one. */
  private fun enrollmentChanged(identityChanged: Boolean) {
    if (identityChanged) {
      dropAllConnections()
      (meshOrigins() + MESH_HUB_ORIGIN).forEach { originChanged?.invoke(it) }
    }
    enrollmentStatusChanged?.invoke()
  }

  /** Closes everything that may carry an identity that no longer applies, and restarts `:stream`. */
  internal fun dropAllConnections() {
    synchronized(lock) {
      invalidateAll()
      sockets.keys.forEach { runCatching { it.close() } }
      sockets.clear()
      calls.values.forEach { it.cancel() }
      evictConnections()
    }
    // A WebView in the stream process may have remembered a decision for the old identity.
    StreamProcess.restart(context)
  }

  /** Cancels what runs for one origin and drops its connections; the module's `retire` too. */
  internal fun retire(origin: String) {
    invalidate(origin)
    calls.values
      .filter { certificateOrigin(it.request().url.toString()) == origin }
      .forEach { it.cancel() }
    sockets.entries
      .filter { it.value == origin }
      .forEach {
        runCatching { it.key.close() }
        sockets.remove(it.key)
      }
    evictConnections()
    StreamProcess.restart(context)
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

  /** The enrolled identity's status; reads the Keystore, never KeyChain. */
  internal fun inspectEnrolled(): CertificateStatus {
    val state = enrollment.state() ?: return CertificateStatus("missing", null)
    return try {
      enrollment.material()
      CertificateStatus("valid", state.current.notAfter)
    } catch (error: EnrolledUnavailable) {
      CertificateStatus(error.state, state.current.notAfter)
    }
  }

  internal fun inspect(alias: String): CertificateStatus =
    loadIdentity(alias).let { certificateStatus(it.chain, it.key != null) }

  /** The enrolled Keystore identity. A mesh origin never falls back to KeyChain from here. */
  private fun enrolledFactory(): SSLSocketFactory =
    try {
      val material =
        enrollment.material() ?: throw IOException("Certificate selection changed. Try again.")
      SSLContext
        .getInstance("TLS")
        .apply {
          init(
            arrayOf(SelectedIdentity(material.alias, material.key, material.chain)),
            arrayOf(trust),
            null
          )
        }
        .socketFactory
    } catch (error: EnrolledUnavailable) {
      enrollmentStatusChanged?.invoke()
      throw IOException(
        "The enrolled device identity is ${error.state}. Re-enroll this device in Mesh.",
        error
      )
    }

  private val identities =
    OriginIdentities(
      enrolled = enrollment::isEnrolled,
      meshOrigin = ::isMesh,
      keyChainAlias = { origin -> preferences.getString(origin, null) },
      fromEnrolled = { enrolledFactory() },
      fromKeyChain = ::keyChainFactory,
      anonymous = { defaultTls.socketFactory }
    )

  private fun identityFactory(origin: String): SSLSocketFactory = identities.factory(origin)

  @Suppress("TooGenericExceptionCaught") // Any KeyChain or TLS setup failure fails the connection.
  private fun keyChainFactory(origin: String, alias: String): SSLSocketFactory =
    try {
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
    private const val RENEW_TIMEOUT_SECONDS = 120L

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
