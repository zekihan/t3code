package expo.modules.t3clientcertificates.direct

import expo.modules.t3clientcertificates.enroll.EnrolledMaterial
import expo.modules.t3clientcertificates.enroll.uriSans
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLException
import javax.net.ssl.SSLSocketFactory
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.EventListener
import okhttp3.Handshake
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import org.json.JSONException
import org.json.JSONObject

/** The identity name in the one URI of a device certificate, `device-<name>-mesh`. */
internal fun callerIdentityOf(material: EnrolledMaterial): String? =
  uriSans(material.chain.first()).first.singleOrNull()?.removePrefix(AGENT_URI_PREFIX)

/** 2 s for TCP and TLS, 5 s for the answer. */
internal data class ProbeDeadlines(val connectMs: Long = 2_000, val responseMs: Long = 5_000)

internal sealed interface ProbeOutcome {
  data class Reached(val identity: IdentityKind, val leafFingerprint: String?) : ProbeOutcome

  data class Failed(val kind: FailureKind, val detail: String) : ProbeOutcome
}

/**
 * Sorts a failed direct connection. A refused agent certificate is the app refusing the agent; an
 * error after the agent check passed is the agent refusing the phone (TLS 1.3 reports a refused
 * client certificate only after the handshake); everything else is the network.
 */
internal fun classifyFailure(
  error: Throwable,
  agentResult: AgentCheckResult?,
  timedOut: String?,
  /**
   * True for a connection that has done nothing but connect: a TLS 1.3 server that refuses the
   * client certificate may close the connection before its alert is read, which shows as a reset.
   */
  freshConnection: Boolean = false
): Pair<FailureKind, String> {
  val causes = generateSequence(error) {
    it.cause?.takeIf { next -> next !== it }
  }.take(CAUSE_DEPTH)
  val refusal = causes.filterIsInstance<AgentCheckException>().firstOrNull()
  val refused =
    causes.any {
      (it is SSLException && ALERT.containsMatchIn(it.message.orEmpty())) ||
        (freshConnection && (it is java.io.EOFException || it is java.net.SocketException))
    }
  return when {
    timedOut != null -> FailureKind.TIMEOUT to timedOut
    refusal != null -> FailureKind.CERTIFICATE to refusal.rejected.failure.message
    agentResult is AgentCheckResult.Accepted && refused ->
      FailureKind.AUTHORIZATION to "The machine did not accept this device's identity."
    else -> FailureKind.UNREACHABLE to (error.message ?: error.javaClass.simpleName)
  }
}

private const val CAUSE_DEPTH = 8

// What a TLS stack says when the peer refused the client certificate, however it words it.
private val ALERT =
  Regex("alert|certificate|unknown.?ca|access.?denied|handshake.?failure", RegexOption.IGNORE_CASE)

/**
 * The side-effect-free probe: `GET /.well-known/t3-mesh/direct` through the loopback proxy, TLS
 * with the agent check only, answered by the agent itself. When the new leaf is refused it tries
 * the previous identity once (item 4's overlap), and reports which one worked.
 */
internal class DirectProber(
  private val proxy: () -> InetSocketAddress?,
  private val tls: DirectTls,
  private val materials: (
    IdentityKind
  ) -> EnrolledMaterial?,
  private val scheduler: ScheduledExecutorService,
  private val deadlines: ProbeDeadlines = ProbeDeadlines()
) {
  fun probe(route: DirectRoute): ProbeOutcome {
    val first = attempt(route, IdentityKind.CURRENT)
    val refused = first is ProbeOutcome.Failed && first.kind == FailureKind.AUTHORIZATION
    val second =
      if (refused && materials(IdentityKind.PREVIOUS) != null) {
        attempt(route, IdentityKind.PREVIOUS)
      } else {
        null
      }
    return if (second is ProbeOutcome.Reached) second else first
  }

  private fun attempt(route: DirectRoute, kind: IdentityKind): ProbeOutcome {
    val address = proxy()
    val material = runCatching { materials(kind) }.getOrNull()
    return when {
      address == null -> ProbeOutcome.Failed(FailureKind.UNREACHABLE, "no local proxy")
      material == null -> ProbeOutcome.Failed(FailureKind.AUTHORIZATION, "no ${kind.wire} identity")
      else -> request(route, kind, address, material)
    }
  }

  private fun request(
    route: DirectRoute,
    kind: IdentityKind,
    address: InetSocketAddress,
    material: EnrolledMaterial
  ): ProbeOutcome {
    val seen = AtomicReference<AgentCheckResult?>()
    val manager = tls.trustManager(route) { seen.set(it) }
    val phases = PhaseDeadlines(scheduler, deadlines)
    val client = client(address, tls.socketFactory(route, material, manager), manager, phases)
    val request =
      Request.Builder()
        .url("https://${viewerHost(route.machine)}$DIRECT_PROBE_PATH")
        .header("Accept", "application/json")
        .build()
    return try {
      client.newCall(request).also(phases::bind).execute().use { response ->
        val code = response.code
        val body = response.peekBody(MAX_BODY).string()
        val fingerprint = (seen.get() as? AgentCheckResult.Accepted)?.leafFingerprint
        when {
          code == 401 || code == 403 ->
            ProbeOutcome.Failed(FailureKind.AUTHORIZATION, "The machine answered HTTP $code.")
          code != 200 -> ProbeOutcome.Failed(FailureKind.UNEXPECTED, "The probe got HTTP $code.")
          !answeredByAgent(body, route, material) ->
            ProbeOutcome.Failed(FailureKind.UNEXPECTED, "The answer was not the agent's.")
          else -> ProbeOutcome.Reached(kind, fingerprint)
        }
      }
    } catch (error: IOException) {
      val (failure, detail) = classifyFailure(
        error,
        seen.get(),
        phases.timedOut,
        freshConnection = true
      )
      ProbeOutcome.Failed(failure, detail)
    } finally {
      phases.finish()
      client.connectionPool.evictAll()
    }
  }

  private fun client(
    address: InetSocketAddress,
    factory: SSLSocketFactory,
    manager: AgentTrustManager,
    phases: PhaseDeadlines
  ) =
    OkHttpClient.Builder()
      .proxy(Proxy(Proxy.Type.HTTP, address))
      .sslSocketFactory(factory, manager)
      // The agent check in the handshake replaces the host name check: there is no name to match.
      .hostnameVerifier { _, _ -> true }
      .connectionPool(ConnectionPool(0, 1, TimeUnit.NANOSECONDS))
      .retryOnConnectionFailure(false)
      .followRedirects(false)
      .followSslRedirects(false)
      .protocols(listOf(Protocol.HTTP_1_1))
      .connectTimeout(deadlines.connectMs, TimeUnit.MILLISECONDS)
      .readTimeout(deadlines.responseMs, TimeUnit.MILLISECONDS)
      .eventListener(phases)
      .build()

  // The agent answers with its machine and the identity of the caller it admitted: ours.
  private fun answeredByAgent(body: String, route: DirectRoute, material: EnrolledMaterial) =
    try {
      val json = JSONObject(body)
      val identity = callerIdentityOf(material)
      identity != null &&
        json.optString("machine") == route.machine &&
        json.optString("identity") == identity
    } catch (_: JSONException) {
      false
    }

  private companion object {
    const val MAX_BODY = 4_096L
  }
}

/**
 * The probe's two deadlines: one from the start of the connection to the end of the TLS handshake
 * (through the proxy), a second from then to the end of the answer. Either one cancels the call.
 */
internal class PhaseDeadlines(
  private val scheduler: ScheduledExecutorService,
  private val deadlines: ProbeDeadlines
) : EventListener() {
  @Volatile var timedOut: String? = null
    private set

  @Volatile private var call: Call? = null
  private var pending: ScheduledFuture<*>? = null

  fun bind(call: Call) {
    this.call = call
  }

  override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) {
    arm(deadlines.connectMs, "TCP and TLS did not finish within ${deadlines.connectMs} ms.")
  }

  override fun secureConnectEnd(call: Call, handshake: Handshake?) {
    arm(deadlines.responseMs, "The machine did not answer within ${deadlines.responseMs} ms.")
  }

  override fun callEnd(call: Call) = finish()

  override fun callFailed(call: Call, ioe: IOException) = finish()

  @Synchronized
  private fun arm(afterMs: Long, message: String) {
    pending?.cancel(false)
    pending =
      scheduler.schedule(
        {
          timedOut = message
          call?.cancel()
        },
        afterMs,
        TimeUnit.MILLISECONDS
      )
  }

  @Synchronized
  fun finish() {
    pending?.cancel(false)
    pending = null
  }
}
