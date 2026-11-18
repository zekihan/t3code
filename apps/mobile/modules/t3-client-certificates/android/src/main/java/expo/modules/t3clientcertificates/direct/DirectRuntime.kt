package expo.modules.t3clientcertificates.direct

import android.content.Context
import android.util.Log
import expo.modules.t3clientcertificates.enroll.EnrollmentManager
import expo.modules.t3clientcertificates.enroll.previousExpired
import expo.modules.t3clientcertificates.stream.StreamEnrolledIdentity
import java.net.Socket
import java.security.GeneralSecurityException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLSocketFactory
import okhttp3.OkHttpClient

private const val TAG = "T3MeshDirect"
private const val HUB_TIMEOUT_SECONDS = 3L
private const val WORKER_THREADS = 3

/**
 * The direct path's parts that the transport owns the lifetime of: the path state, the OkHttp
 * pieces that route requests, and the Android hooks (network changes, the enrolled identities).
 * The transport adds [configure] to every client it builds and nothing else.
 */
internal class DirectRuntime(
  private val context: Context,
  private val enrollment: EnrollmentManager,
  hubClient: () -> OkHttpClient,
  private val evictConnections: () -> Unit,
  private val restartStreams: () -> Unit,
  private val baseVerifier: HostnameVerifier
) {
  /** Called, off the main thread, when a machine's path or the reason for it changed. */
  @Volatile var changed: ((machine: String) -> Unit)? = null

  private val identities =
    object : DirectIdentities {
      @Suppress("TooGenericExceptionCaught") // An identity that cannot be read is not available.
      override fun material(kind: IdentityKind) =
        try {
          when (kind) {
            IdentityKind.CURRENT -> enrollment.material()
            IdentityKind.PREVIOUS -> enrollment.previousMaterial()
          }
        } catch (_: GeneralSecurityException) {
          null
        } catch (_: RuntimeException) {
          null
        } catch (_: expo.modules.t3clientcertificates.enroll.EnrolledUnavailable) {
          null
        }

      override fun stream(kind: IdentityKind): StreamEnrolledIdentity? {
        val state = enrollment.state() ?: return null
        val credential =
          when (kind) {
            IdentityKind.CURRENT -> state.current
            IdentityKind.PREVIOUS ->
              state.previous?.takeUnless {
                previousExpired(it, System.currentTimeMillis())
              }?.credential
          }
        return credential?.let { StreamEnrolledIdentity(it.alias, it.chainPem) }
      }
    }

  private val hub by lazy {
    DirectHub(hubClient().newBuilder().callTimeout(HUB_TIMEOUT_SECONDS, TimeUnit.SECONDS).build())
  }

  val paths =
    DirectPaths(
      store = PreferencesDirectStore(
        context.getSharedPreferences(DIRECT_PREFERENCES, Context.MODE_PRIVATE)
      ),
      clock = System::currentTimeMillis,
      identities = identities,
      hubFleet = { hub.fleet() },
      hubTrust = { hub.trust() },
      worker =
        Executors.newScheduledThreadPool(WORKER_THREADS) { runnable ->
          Thread(runnable, "t3-direct").apply { isDaemon = true }
        },
      log = { Log.i(TAG, it) },
      onChange = { changed?.invoke(it.machine) },
      streamsLost = { restartStreams() }
    ).also { it.evictConnections = evictConnections }

  private val pins = PathPins()
  private val interceptor = DirectRoutingInterceptor(paths, pins)
  private val guard = DirectPathGuard()
  private val selector = DirectProxySelector(paths, pins)

  /** The host name verifier of the transport's clients: the base one, or the agent check. */
  val hostnameVerifier: HostnameVerifier =
    DirectHostnameVerifier(baseVerifier, paths::agentCheckFor)

  /** The direct path for a stream of the viewer [origin], as the stream process needs it, or null. */
  fun streamRouting(sessionId: String, origin: String): StreamRouting? {
    val machine = machineOfViewerHost(java.net.URI(origin).host) ?: return null
    return paths.streamRouting(sessionId, machine)
  }

  fun streamClosed(sessionId: String) = paths.streamClosed(sessionId)

  /** A TLS factory for a connection through the direct proxy; null for any other connection. */
  fun socketFactoryFor(origin: String, raw: Socket): SSLSocketFactory? =
    paths.socketFactoryFor(origin, raw)

  /** Routes a mesh viewer host's requests, once however often a builder is configured. */
  fun configure(builder: OkHttpClient.Builder): OkHttpClient.Builder {
    builder.proxySelector(selector)
    if (builder.interceptors().none { it is DirectRoutingInterceptor }) {
      builder.addInterceptor(interceptor)
    }
    if (builder.networkInterceptors().none { it is DirectPathGuard }) {
      builder.addNetworkInterceptor(guard)
    }
    return builder
  }

  /** Called when the enrollment changed; a new identity may be accepted or refused by a machine. */
  fun enrollmentChanged(identityChanged: Boolean) {
    paths.setEnrolled(enrollment.isEnrolled())
    if (identityChanged) paths.identityChanged()
  }

  fun start() {
    DirectNetwork(paths::networkChanged).register(context)
    paths.setEnrolled(enrollment.isEnrolled())
  }
}
