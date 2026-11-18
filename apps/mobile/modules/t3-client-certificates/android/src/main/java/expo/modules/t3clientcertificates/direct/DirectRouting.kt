package expo.modules.t3clientcertificates.direct

import java.io.IOException
import java.net.InetSocketAddress
import java.net.ProtocolException
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response

/** The path one request takes: through the loopback proxy to the machine, or to the viewer host. */
internal data class ActivePath(
  val direct: Boolean,
  val identity: IdentityKind? = null,
  val reason: ViewerReason? = null
) {
  companion object {
    val VIEWER = ActivePath(direct = false)
  }
}

/** What the OkHttp pieces need from the path state. */
internal interface DirectRouter {
  /** The path for a request to [machine]; waits for a pending decision within a bound. */
  fun awaitPath(machine: String): ActivePath

  /** The loopback proxy of the direct path, or null while it is not running. */
  fun relayAddress(): InetSocketAddress?

  /** A request on the direct path failed with [error]; the machine leaves the direct path. */
  fun directFailed(machine: String, error: IOException)

  /** A request that may have reached the machine failed on the direct path and was not repeated. */
  fun unknownOutcome(machine: String, method: String)

  /** Drops idle connections: one of them is on the wrong path. */
  fun evictIdleConnections()
}

/** Only these may be sent again on the other path after a request was sent: they change nothing. */
internal fun replaySafe(method: String) = method == "GET" || method == "HEAD"

/** The request failed on the direct path after it may have reached T3, so it was not repeated. */
internal class UnknownOutcomeException(
  val method: String,
  cause: IOException
) : IOException(
  "The direct connection failed after the $method request was sent, so whether it took " +
    "effect is unknown. It was not repeated through the viewer host: ${cause.message}",
  cause
)

/**
 * A direct request that is not replay-safe failed after it was written. OkHttp would send it again
 * on a new connection (a [ProtocolException] is the one failure it never retries), and a request
 * that may have reached T3 is never repeated automatically.
 */
internal class SentRequestFailedException(cause: IOException) : ProtocolException(cause.message) {
  init {
    initCause(cause)
  }
}

/** A pooled connection is on the other path than the request's; nothing was sent on it. */
internal class PathMismatchException : IOException("The connection is on another path.")

/** What one attempt of a request is told and tells back. */
internal class Attempt(val direct: Boolean) {
  @Volatile var sent = false
}

/** The path chosen for the call running on this thread, for the proxy selector to read. */
internal class PathPins {
  class Pin(val host: String, val direct: Boolean)

  private val pin = ThreadLocal<Pin?>()

  fun current(): Pin? = pin.get()

  fun <T> run(host: String, direct: Boolean, block: () -> T): T {
    val before = pin.get()
    pin.set(Pin(host, direct))
    try {
      return block()
    } finally {
      pin.set(before)
    }
  }
}

/**
 * Routes requests to a mesh viewer host. This is an application interceptor, so it sees every
 * request of every OkHttp client the transport configures (React Native fetch and WebSocket,
 * expo fetch, Fresco and the native transfers):
 *
 * - the path is chosen once, before the request is sent, and kept for the whole call;
 * - a request that fails on the direct path before anything was written goes to the viewer host;
 * - one that fails after it may have reached T3 goes to the viewer host only when it is a GET or
 *   HEAD (a WebSocket open is a GET) and otherwise fails as an unknown outcome.
 */
internal class DirectRoutingInterceptor(
  private val router: DirectRouter,
  private val pins: PathPins
) : Interceptor {
  override fun intercept(chain: Interceptor.Chain): Response {
    val request = chain.request()
    val machine = machineOfViewerHost(request.url.host)?.takeIf { isViewerUrl(request.url) }
    if (machine == null) return chain.proceed(request)
    var path = router.awaitPath(machine)
    if (path.direct && router.relayAddress() == null) path = ActivePath.VIEWER
    var mismatches = 0
    while (true) {
      val attempt = Attempt(path.direct)
      try {
        return send(chain, request, attempt)
      } catch (_: PathMismatchException) {
        if (++mismatches > MAX_MISMATCHES) throw IOException("No connection on the chosen path.")
        router.evictIdleConnections()
      } catch (error: IOException) {
        path = afterFailure(chain, request, machine, attempt, error)
      }
    }
  }

  private fun isViewerUrl(url: HttpUrl) = url.isHttps && url.port == VIEWER_PORT

  private fun send(chain: Interceptor.Chain, request: Request, attempt: Attempt): Response {
    val tagged = request.newBuilder().tag(Attempt::class.java, attempt).build()
    return pins.run(request.url.host, attempt.direct) { chain.proceed(tagged) }
  }

  // The path for the next attempt, or the failure itself when there is none to try.
  private fun afterFailure(
    chain: Interceptor.Chain,
    request: Request,
    machine: String,
    attempt: Attempt,
    error: IOException
  ): ActivePath {
    if (!attempt.direct || chain.call().isCanceled()) throw error
    router.directFailed(machine, error)
    if (attempt.sent && !replaySafe(request.method)) {
      router.unknownOutcome(machine, request.method)
      throw UnknownOutcomeException(request.method, error)
    }
    return ActivePath.VIEWER
  }

  private companion object {
    const val MAX_MISMATCHES = 3
  }
}

/**
 * Checks, just before a request is written, that its connection is on the path the call chose:
 * a pooled connection may be a direct tunnel when the call chose the viewer host, or the other
 * way round. It also marks the request as sent. Nothing is written on a mismatch.
 */
internal class DirectPathGuard : Interceptor {
  override fun intercept(chain: Interceptor.Chain): Response {
    val request = chain.request()
    val attempt = request.tag(Attempt::class.java) ?: return chain.proceed(request)
    val tunnelled = chain.connection()?.route()?.proxy?.type() == Proxy.Type.HTTP
    if (tunnelled != attempt.direct) throw PathMismatchException()
    attempt.sent = true
    return try {
      chain.proceed(request)
    } catch (error: IOException) {
      throw if (attempt.direct &&
        !replaySafe(request.method)
      ) {
        SentRequestFailedException(error)
      } else {
        error
      }
    }
  }
}

/**
 * Sends a pinned direct call to the loopback proxy, and everything else where it went before.
 * A mesh viewer host reaches the proxy only when the call running on this thread chose the direct
 * path: nothing else is ever sent to the proxy.
 */
internal class DirectProxySelector(
  private val router: DirectRouter,
  private val pins: PathPins,
  private val base: () -> ProxySelector? = { ProxySelector.getDefault() }
) : ProxySelector() {
  override fun select(uri: URI?): List<Proxy> {
    val relay = if (pinnedDirect(uri)) router.relayAddress() else null
    return if (relay != null) {
      listOf(Proxy(Proxy.Type.HTTP, relay))
    } else {
      base()?.select(uri) ?: listOf(Proxy.NO_PROXY)
    }
  }

  private fun pinnedDirect(uri: URI?): Boolean {
    val pin = pins.current()
    return uri != null && pin != null && pin.direct && pin.host == uri.host
  }

  override fun connectFailed(uri: URI?, address: SocketAddress?, error: IOException?) {
    base()?.connectFailed(uri, address, error)
  }
}
