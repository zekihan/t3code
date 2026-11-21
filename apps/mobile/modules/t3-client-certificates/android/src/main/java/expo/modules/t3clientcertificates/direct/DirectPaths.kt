package expo.modules.t3clientcertificates.direct

import expo.modules.t3clientcertificates.enroll.EnrolledMaterial
import expo.modules.t3clientcertificates.localnet.LocalNetworkState
import expo.modules.t3clientcertificates.stream.DirectStream
import expo.modules.t3clientcertificates.stream.StreamEnrolledIdentity
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** The enrolled identities the direct path can present, current and previous. */
internal interface DirectIdentities {
  fun material(kind: IdentityKind): EnrolledMaterial?

  fun stream(kind: IdentityKind): StreamEnrolledIdentity?
}

/** What the `:stream` process needs to use the direct path for one stream. */
internal class StreamRouting(
  val proxyPort: Int,
  val host: String,
  val caBundlePem: String,
  val revoked: Set<String>,
  val agentIdentity: String,
  val identity: StreamEnrolledIdentity
) {
  fun toStream() = DirectStream(proxyPort, host, caBundlePem, revoked.toList(), agentIdentity)
}

/** What the connection details show for one machine. */
internal data class DirectStatus(
  val direct: Boolean,
  val reason: ViewerReason?,
  val identity: IdentityKind?,
  /** The latest certificate or authorization failure, kept until a probe passes. */
  val failure: DirectFailure?,
  /** The latest failure that only means the machine could not be reached. */
  val unreachable: DirectFailure?,
  val unknownOutcomeAt: Long?,
  val unknownOutcomeMethod: String?,
  val probing: Boolean,
  val trustFetchedAt: Long?,
  val routeSavedAt: Long?
)

internal data class DirectCheck(val at: Long, val result: String) {
  fun toMap() = mapOf("at" to at, "result" to result)
}

/** An open stream's machine and whether it was given the direct path. */
private class OpenStream(val machine: String, val identity: IdentityKind?) {
  val direct get() = identity != null
}

internal class PathChange(val machine: String, val wasDirect: Boolean, val isDirect: Boolean)

internal data class DirectTimings(
  /** The longest a request waits for a path decision. */
  val maxWaitMs: Long = 8_000,
  /** The proxy stops this long after the last machine left the direct path. */
  val idleStopMs: Long = 30_000,
  /** A hub contact right after another one is not repeated. */
  val hubDebounceMs: Long = 2_000,
  /** A probe does not wait longer than this for a hub contact that has not answered yet. */
  val hubWaitMs: Long = 1_500,
  /** How often a waiting request looks at its decision again, for time passing with no event. */
  val recheckMs: Long = 250,
  /** An away verdict this old is asked about again when a request meets it. */
  val awayRecheckMs: Long = 30_000
)

/**
 * The state of the direct path for every machine, and what runs it: the hub contact that refreshes
 * trust, routes and the home gate, the probes, and the loopback proxy's lifetime. [DirectPathModel]
 * decides; this class runs the I/O, serializes access and tells listeners what changed.
 */
@Suppress("TooManyFunctions", "LongParameterList")
internal class DirectPaths(
  private val store: DirectStore,
  private val clock: () -> Long,
  private val identities: DirectIdentities,
  private val hubFleet: () -> HubReply<FleetAnswer>,
  private val hubTrust: () -> HubReply<DirectTrust>,
  private val worker: ScheduledExecutorService,
  private val timings: DirectTimings = DirectTimings(),
  private val deadlines: ProbeDeadlines = ProbeDeadlines(),
  private val limits: ProxyLimits = ProxyLimits(),
  /** Where a route's address goes: the LAN address by default; tests dial a local server. */
  private val addressOf: (String) -> InetAddress? = ::parseLanAddress,
  /** Whether Android lets the app reach LAN addresses; the path model never probes without it. */
  private val localNetwork: () -> LocalNetworkState = { LocalNetworkState.NOT_REQUIRED },
  private val log: (String) -> Unit = {},
  private val onChange: (PathChange) -> Unit = {},
  /** Called when the verified listener's checks or a direct failure need the stream process ended. */
  private val streamsLost: (machine: String) -> Unit = {}
) : DirectRouter {
  val decisions = DirectDecisionLog(clock)

  private val lock = ReentrantLock()
  private val changed = lock.newCondition()
  private val model = DirectPathModel(clock)
  private val tls = DirectTls({ lock.withLock { model.trust } }, clock)

  private val relay =
    DirectProxy(::resolveTarget, null, limits)

  private val verified =
    DirectProxy(
      ::resolveTarget,
      ::verifyPeer,
      limits,
      onRefused = { machine, refused ->
        decisions.record("fallback", FailureKind.CERTIFICATE.code, machine)
        mutate { model.directBroke(machine, FailureKind.CERTIFICATE, refused.failure.message) }
      }
    )

  private val prober =
    DirectProber(
      ::relayAddress,
      tls,
      { kind -> identities.material(kind) },
      worker,
      deadlines
    )

  private val probing = mutableMapOf<String, CompletableFuture<String>>()
  private val lastProbes = mutableMapOf<String, DirectCheck>()
  private var lastHomeCheck: DirectCheck? = null
  private val announced = mutableMapOf<String, String>()
  private val wasDirect = mutableMapOf<String, Boolean>()
  private val agentResults = java.util.concurrent.ConcurrentHashMap<String, AgentCheckResult>()
  private val unknownOutcomes = mutableMapOf<String, Pair<Long, String>>()
  private val streamSessions = mutableMapOf<String, OpenStream>()
  private var hubRunning = false
  private var hubAgain = false
  private var hubStartedNanos = 0L
  private var hubSettledEpoch = -1L
  private var lastHubAt = 0L
  private var lastHubAnswerAt = 0L
  private var idleStop: ScheduledFuture<*>? = null
  private var streamIdleStop: ScheduledFuture<*>? = null
  private var expiry: ScheduledFuture<*>? = null

  init {
    lock.withLock {
      model.restore(store.load())
      model.localNetworkChanged(localNetwork())
    }
  }

  // ---- inputs ----

  /** The device enrolled or lost its enrollment. */
  fun setEnrolled(enrolled: Boolean) {
    mutate { model.enrolled = enrolled }
    if (enrolled) refreshHub(force = false)
  }

  /** Tells the path state the hub was just contacted by the app: refresh trust and routes. */
  fun refreshHub(force: Boolean) {
    lock.withLock { startHubContactLocked(force) }
  }

  /**
   * The local network permission may have changed (the prompt was answered, or Settings was used).
   * A grant brings the hub contact and the probes back at once; they were skipped, or timed out,
   * while the platform dropped the packets.
   */
  fun refreshLocalNetwork() {
    val next = localNetwork()
    val before = lock.withLock { model.localNetwork }
    mutate { model.localNetworkChanged(next) }
    if (before == LocalNetworkState.DENIED && next != LocalNetworkState.DENIED) {
      refreshHub(force = true)
    }
  }

  /** The enrolled identity changed: a machine may accept or refuse the new one. */
  fun identityChanged() {
    mutate { model.clearProbes() }
  }

  /** The phone's network changed: nothing learned on the old one applies. */
  fun networkChanged() {
    log("network changed")
    decisions.record("network", "changed")
    mutate {
      model.networkChanged()
      hubSettledEpoch = -1
    }
    refreshHub(force = true)
  }

  /** The path state forgets everything: the device is no longer enrolled for mesh hosts. */
  fun forget() {
    mutate {
      model.forget()
      lastProbes.clear()
      lastHomeCheck = null
    }
    store.save(DirectSnapshot(null, emptyMap()))
  }

  // ---- the router the OkHttp pieces use ----

  override fun awaitPath(machine: String): ActivePath {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timings.maxWaitMs)
    lock.withLock {
      while (true) {
        decidedLocked(machine)?.let { return it }
        val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
        if (remaining <= 0) {
          decisions.record("fallback", ViewerReason.PENDING.code, machine)
          return ActivePath(false, reason = ViewerReason.PENDING)
        }
        changed.await(minOf(remaining, timings.recheckMs), TimeUnit.MILLISECONDS)
      }
    }
  }

  // The path when it is decided; otherwise starts what the decision waits for and returns null.
  private fun decidedLocked(machine: String): ActivePath? =
    when (val decision = model.decision(machine)) {
      is PathDecision.Direct -> {
        ensureRelayLocked()
        ActivePath(true, decision.identity)
      }
      is PathDecision.Viewer -> {
        if (decision.reason == ViewerReason.AWAY) confirmAwayLocked()
        ActivePath(false, reason = decision.reason)
      }
      PathDecision.Probe -> {
        startPendingLocked(machine)
        null
      }
    }

  // An away verdict is only as good as the last hub answer behind it. A request that meets an old
  // one asks the hub again in the background, so that a hub that has gone away since is noticed
  // (the verdict then lapses) and one that still says away keeps the viewer host, at a cost of one
  // contact per awayRecheckMs of use.
  private fun confirmAwayLocked() {
    if (clock() - lastHubAnswerAt >= timings.awayRecheckMs) startHubContactLocked(force = false)
  }

  // The hub answers first, because it says whether the phone is home; then the probe runs. A hub
  // that is slow or silent only says so for so long: it must not hold the probe back, because the
  // probe is bounded and decides alone when the hub never answers.
  private fun startPendingLocked(machine: String) {
    if (hubSettledEpoch != model.epoch) {
      startHubContactLocked(force = false)
      val waited = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - hubStartedNanos)
      if (hubRunning && waited >= timings.hubWaitMs) startProbeLocked(machine)
    } else {
      startProbeLocked(machine)
    }
  }

  // The proxy stops when no machine is direct; a decision that is direct again brings it back, so a
  // cached decision never meets a stopped proxy and silently takes the viewer host.
  @Suppress("SwallowedException") // No proxy means the request takes the viewer host.
  private fun ensureRelayLocked() {
    try {
      relay.start()
    } catch (_: IOException) {
      // relayAddress() stays null.
    }
  }

  override fun relayAddress(): InetSocketAddress? =
    relay.port.takeIf { it != 0 }?.let { InetSocketAddress(InetAddress.getByAddress(LOOPBACK), it) }

  override fun directFailed(machine: String, error: IOException, freshConnection: Boolean) {
    val (kind, detail) = classifyFailure(error, agentResults[machine], null, freshConnection)
    log("direct request to $machine failed (${kind.code}): $detail")
    decisions.record("fallback", kind.code, machine)
    mutate { if (model.directBroke(machine, kind, detail)) startProbeLocked(machine) }
    if (kind.shown) relay.closeTunnels(machine)
  }

  override fun unknownOutcome(machine: String, method: String) {
    log("$method to $machine failed after it was sent on the direct path; not repeated")
    mutate { unknownOutcomes[machine] = clock() to method }
  }

  override fun evictIdleConnections() = evictConnections()

  /** Set by the transport: drops idle pooled connections. */
  @Volatile var evictConnections: () -> Unit = {}

  /** The socket factory for a connection that came through the loopback proxy, or null if not. */
  @Suppress("ThrowsCount") // Each refusal is a different way the direct connection cannot be made.
  fun socketFactoryFor(origin: String, raw: Socket): SSLSocketFactory? {
    if (!relay.isProxyEndpoint(raw.inetAddress, raw.port)) return null
    val machine =
      machineOfViewerHost(URI(origin).host) ?: throw IOException("Not a mesh viewer host.")
    val (route, kind) =
      lock.withLock {
        val route = model.routeFor(machine) ?: throw IOException("The direct route is gone.")
        route to
          ((model.probe(machine) as? ProbeRecord.Succeeded)?.identity ?: IdentityKind.CURRENT)
      }
    val material =
      identities.material(kind)
        ?: throw IOException("The enrolled device identity is unavailable.")
    return tls.socketFactory(
      route,
      material,
      tls.trustManager(route) {
        agentResults[machine] = it
      }
    )
  }

  /** The agent check for the machine behind [host], for the host name verifier. */
  fun agentCheckFor(host: String): AgentCheck? =
    machineOfViewerHost(host)
      ?.let { machine -> lock.withLock { model.routeFor(machine) } }
      ?.let(tls::checkFor)

  // ---- what the screen and the streams read ----

  fun status(machine: String): DirectStatus =
    lock.withLock { statusLocked(machine) }

  fun diagnostics(machine: String): Map<String, Any?> =
    lock.withLock {
      val status = statusLocked(machine)
      mapOf(
        "path" to if (status.direct) "direct" else "viewer",
        "reason" to status.reason?.code,
        "trustFetchedAt" to status.trustFetchedAt,
        "homeCheck" to lastHomeCheck?.toMap(),
        "probe" to lastProbes[machine]?.toMap()
      )
    }

  fun testDirectPath(machine: String): CompletableFuture<String> {
    refreshLocalNetwork()
    return lock.withLock {
      val decision = model.decision(machine)
      if (decision is PathDecision.Viewer && decision.reason != ViewerReason.PROBE_FAILED) {
        CompletableFuture.completedFuture(decision.reason.code)
      } else {
        startProbeLocked(machine)
      }
    }
  }

  /**
   * The route for a stream of [machine], or null for the viewer host. It never waits: a stream opens
   * on the main thread, after the environment's own requests have settled the decision. While any
   * stream of the machine is open every other one takes the same path, because the stream process
   * applies its proxy settings to the machine's host as a whole.
   */
  fun streamRouting(sessionId: String, machine: String): StreamRouting? {
    val kind =
      lock.withLock {
        val existing = streamSessions.values.firstOrNull { it.machine == machine }
        if (existing != null) {
          existing.identity
        } else {
          (decisionNowLocked(machine) as? PathDecision.Direct)?.identity
        }
      }
    val routing = kind?.let { routingFor(machine, it) }
    lock.withLock {
      streamSessions[sessionId] = OpenStream(machine, if (routing != null) kind else null)
      if (routing != null) streamIdleStop?.cancel(false)
      decisions.record("stream", if (routing != null) "direct" else "viewer", machine)
      if (kind != null && routing == null) {
        decisions.record("fallback", "stream-unavailable", machine)
      }
    }
    return routing
  }

  private fun decisionNowLocked(machine: String): PathDecision {
    val decision = model.decision(machine)
    // Not known yet: learn it for the next stream, and use the viewer host for this one.
    if (decision == PathDecision.Probe) startPendingLocked(machine)
    return decision
  }

  private fun routingFor(machine: String, kind: IdentityKind): StreamRouting? {
    val (route, trust) = lock.withLock { model.routeFor(machine) to model.trust }
    val identity = identities.stream(kind)
    if (route == null || trust == null || identity == null) return null
    val port = lock.withLock { verified.start() }
    return StreamRouting(
      port,
      viewerHost(machine),
      trust.caBundlePem,
      trust.revoked,
      route.agentIdentity,
      identity
    )
  }

  fun streamClosed(sessionId: String) {
    lock.withLock {
      streamSessions.remove(sessionId)
      if (streamSessions.values.none { it.direct } && verified.isRunning) {
        streamIdleStop?.cancel(false)
        streamIdleStop =
          worker.schedule(
            { lock.withLock { if (streamSessions.values.none { it.direct }) verified.stop() } },
            timings.idleStopMs,
            TimeUnit.MILLISECONDS
          )
      }
    }
  }

  // ---- hub contact ----

  private fun startHubContactLocked(force: Boolean) {
    val recent = clock() - lastHubAt < timings.hubDebounceMs && hubSettledEpoch == model.epoch
    val skip = recent && !force
    // A forced contact asked for while one runs follows it: the running one may predate the reason.
    if (hubRunning && force) hubAgain = true
    if (hubRunning || !model.enrolled || skip) return
    hubRunning = true
    hubStartedNanos = System.nanoTime()
    val epoch = model.epoch
    worker.execute { hubContact(epoch) }
  }

  // The home gate and the routes come first, and requests stop waiting for the hub once they are in;
  // the trust follows. A contact that fails leaves the cache as it was, except that an away verdict
  // lapses (see [DirectPathModel.hubFailed]); either way the contact is over and probing goes on.
  private fun hubContact(epoch: Long) {
    val fleet = hubAttempt(hubFleet)
    log("hub contact: fleet ${describe(fleet)}")
    mutate {
      when (fleet) {
        is HubReply.Ok -> {
          // The gate describes the network the request was made on.
          val gate = if (epoch == model.epoch) fleet.value.gate else model.gate
          model.hubAnswered(gate, fleet.value.routes)
          lastProbes.keys.retainAll(model.routes.keys)
          lastHubAnswerAt = clock()
          store.save(model.snapshot())
        }
        is HubReply.Failed -> if (epoch == model.epoch) model.hubFailed()
      }
      val result =
        when (fleet) {
          is HubReply.Ok -> fleet.value.gate.name.lowercase()
          is HubReply.Failed -> "failed"
        }
      decisions.record("home", result)
      if (epoch == model.epoch) {
        hubSettledEpoch = epoch
        if (model.enrolled) lastHomeCheck = DirectCheck(clock(), result)
      }
      lastHubAt = clock()
    }
    val trust = hubAttempt(hubTrust)
    log("hub contact: trust ${describe(trust)}")
    decisions.record("trust", if (trust is HubReply.Ok) "ok" else "failed")
    var again = false
    mutate {
      if (trust is HubReply.Ok) {
        model.trustRefreshed(trust.value)
        store.save(model.snapshot())
      }
      hubRunning = false
      again = hubAgain
      hubAgain = false
    }
    // The network changed while this contact ran, and its own request was skipped for it, or a
    // forced contact was asked for meanwhile: that contact runs now, not when the next request asks.
    lock.withLock {
      if (again || hubSettledEpoch != model.epoch) startHubContactLocked(force = true)
    }
  }

  @Suppress("TooGenericExceptionCaught") // Whatever goes wrong, the contact simply failed.
  private fun <T> hubAttempt(request: () -> HubReply<T>): HubReply<T> =
    try {
      request()
    } catch (error: Exception) {
      HubReply.Failed(error.message ?: error.javaClass.simpleName)
    }

  private fun <T> describe(reply: HubReply<T>) =
    if (reply is HubReply.Failed) "failed (${reply.detail})" else "ok"

  // ---- probes ----

  private fun startProbeLocked(machine: String): CompletableFuture<String> =
    probing.getOrPut(machine) {
      val epoch = model.epoch
      CompletableFuture.supplyAsync({ runProbe(machine, epoch) }, worker)
    }

  @Suppress("TooGenericExceptionCaught") // Any failure of a probe is its outcome.
  private fun runProbe(machine: String, epoch: Long): String {
    val route = lock.withLock { model.routeFor(machine) }
    val outcome: ProbeOutcome =
      if (route == null) {
        ProbeOutcome.Failed(FailureKind.UNREACHABLE, "no route")
      } else {
        try {
          lock.withLock { relay.start() }
          prober.probe(route)
        } catch (error: Exception) {
          ProbeOutcome.Failed(FailureKind.UNREACHABLE, error.message ?: error.javaClass.simpleName)
        }
      }
    log("probe of $machine: ${describeOutcome(outcome)}")
    var result = "stale"
    mutate {
      probing.remove(machine)
      val current = epoch == model.epoch
      when (outcome) {
        is ProbeOutcome.Reached -> {
          model.probeSucceeded(machine, epoch, outcome.identity, outcome.leafFingerprint)
          if (current) result = "ok"
        }
        is ProbeOutcome.Failed -> {
          model.probeFailed(machine, epoch, outcome.kind, outcome.detail)
          if (current) result = outcome.kind.code
        }
      }
      if (current) lastProbes[machine] = DirectCheck(clock(), result)
      decisions.record("probe", result, machine)
    }
    return result
  }

  private fun describeOutcome(outcome: ProbeOutcome) =
    when (outcome) {
      is ProbeOutcome.Reached -> "direct with the ${outcome.identity.wire} identity"
      is ProbeOutcome.Failed -> "failed (${outcome.kind.code}): ${outcome.detail}"
    }

  // ---- the checking listener for streams ----

  private fun resolveTarget(host: String, port: Int): ProxyTarget? {
    val machine = machineOfViewerHost(host)?.takeIf { port == VIEWER_PORT }
    val route = machine?.let { name -> lock.withLock { model.routeFor(name) } }
    val address = route?.let { addressOf(it.address) }
    return if (machine != null && route != null && address != null) {
      ProxyTarget(machine, address, route.port)
    } else {
      null
    }
  }

  // The proxy's own handshake, with no client identity: only the agent's certificate matters here.
  private fun verifyPeer(target: ProxyTarget): PeerVerdict {
    val route =
      lock.withLock { model.routeFor(target.machine) }
        ?: return PeerVerdict.Refused(AgentFailure.NO_TRUST, "no route")
    val seen = AtomicReference<AgentCheckResult?>()
    val manager = tls.trustManager(route) { seen.set(it) }
    val raw = Socket()
    try {
      raw.connect(InetSocketAddress(target.address, target.port), limits.connectTimeoutMs)
      raw.soTimeout = limits.connectTimeoutMs
      val ssl =
        tls.anonymousFactory(
          manager
        ).createSocket(raw, viewerHost(target.machine), VIEWER_PORT, true)
          as SSLSocket
      ssl.startHandshake()
    } catch (_: IOException) {
      // The check ran if the peer got as far as its certificate; read the result below.
    } finally {
      runCatching { raw.close() }
    }
    return when (val result = seen.get()) {
      is AgentCheckResult.Accepted -> PeerVerdict.Accepted
      is AgentCheckResult.Rejected -> PeerVerdict.Refused(result.failure, result.detail)
      null -> PeerVerdict.Unreachable("no certificate from ${target.address.hostAddress}")
    }
  }

  // ---- bookkeeping ----

  private fun statusLocked(machine: String): DirectStatus {
    val decision = model.decision(machine)
    val direct = decision as? PathDecision.Direct
    val probe = model.probe(machine) as? ProbeRecord.Failed
    val unreachable = probe?.failure?.takeIf { !it.kind.shown }
    return DirectStatus(
      direct = direct != null,
      reason =
        when (decision) {
          is PathDecision.Viewer -> decision.reason
          PathDecision.Probe -> ViewerReason.PENDING
          is PathDecision.Direct -> null
        },
      identity = direct?.identity,
      failure = model.shownFailure(machine),
      unreachable = unreachable,
      unknownOutcomeAt = unknownOutcomes[machine]?.first,
      unknownOutcomeMethod = unknownOutcomes[machine]?.second,
      probing = machine in probing,
      trustFetchedAt = model.trust?.fetchedAt,
      routeSavedAt = model.routes[machine]?.savedAt
    )
  }

  private fun signature(status: DirectStatus) =
    listOf(
      status.direct,
      status.reason,
      status.identity,
      status.failure?.at,
      status.unreachable?.at,
      status.unknownOutcomeAt,
      status.probing
    ).joinToString("/")

  /** Runs [block] under the lock, then tells listeners what changed, outside it. */
  private fun mutate(block: () -> Unit) {
    val changes = mutableListOf<PathChange>()
    val lost = mutableListOf<String>()
    lock.withLock {
      block()
      (model.routes.keys + announced.keys).toSet().forEach { machine ->
        val status = statusLocked(machine)
        val now = signature(status)
        if (announced[machine] != now) {
          announced[machine] = now
          val before = wasDirect[machine] ?: false
          wasDirect[machine] = status.direct
          changes += PathChange(machine, before, status.direct)
          decisions.record(
            "path",
            if (status.direct) "direct" else checkNotNull(status.reason).code,
            machine
          )
          log(
            "path of $machine: ${if (status.direct) "direct" else "viewer host (${status.reason?.code})"}"
          )
          if (before && !status.direct && hasDirectStream(machine)) lost += machine
        }
      }
      scheduleExpiryLocked()
      scheduleIdleStopLocked()
      changed.signalAll()
    }
    changes.forEach {
      if (it.wasDirect && !it.isDirect) {
        evictConnections()
        relay.closeTunnels(it.machine)
      }
      onChange(it)
    }
    lost.forEach(streamsLost)
  }

  private fun hasDirectStream(machine: String) =
    streamSessions.values.any { it.machine == machine && it.direct }

  private fun relayIdleLocked() =
    wasDirect.values.none { it } && probing.isEmpty() && relay.openTunnels == 0

  private fun scheduleIdleStopLocked() {
    val anyDirect = wasDirect.values.any { it } || probing.isNotEmpty()
    if (anyDirect || !relay.isRunning) {
      idleStop?.cancel(false)
      return
    }
    if (idleStop?.isDone == false) return
    idleStop =
      worker.schedule(
        { lock.withLock { if (relayIdleLocked()) relay.stop() } },
        timings.idleStopMs,
        TimeUnit.MILLISECONDS
      )
  }

  // The week-long expiries are not events: a timer re-reads the decisions when one comes due.
  private fun scheduleExpiryLocked() {
    val now = clock()
    val due =
      listOfNotNull(model.trust?.fetchedAt?.plus(DIRECT_CACHE_MS)) +
        model.routes.values.map { it.savedAt + DIRECT_CACHE_MS }
    val next = due.filter { it > now }.minOrNull() ?: return
    expiry?.cancel(false)
    expiry = worker.schedule({ mutate {} }, next - now + 1, TimeUnit.MILLISECONDS)
  }

  /** Stops the proxies and timers; the app is closing. */
  fun shutdown() {
    lock.withLock {
      idleStop?.cancel(false)
      streamIdleStop?.cancel(false)
      expiry?.cancel(false)
    }
    relay.stop()
    verified.stop()
  }

  private companion object {
    val LOOPBACK = byteArrayOf(127, 0, 0, 1)
  }
}
