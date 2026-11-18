package expo.modules.t3clientcertificates.direct

/** Which of the phone's two enrolled identities a direct connection presents. */
internal enum class IdentityKind(val wire: String) {
  CURRENT("current"),

  /** The identity a renewal replaced, kept for a week for a machine that has not heard of the new one. */
  PREVIOUS("previous")
}

/** What the hub's own request said about where the phone is: `caller.path` of `/api/v1/fleet`. */
internal enum class HubGate {
  /** No hub answer since the network last changed. */
  UNKNOWN,
  HOME,
  AWAY
}

/** Why a machine is on the viewer host, or that a direct attempt must run to find out. */
internal enum class ViewerReason(val code: String) {
  NOT_ENROLLED("not-enrolled"),
  NO_TRUST("no-trust"),
  TRUST_EXPIRED("trust-expired"),
  NO_ROUTE("no-route"),
  ROUTE_EXPIRED("route-expired"),
  AWAY("away"),
  PROBE_FAILED("probe-failed"),

  /** Not a cached decision: the answer for a request that did not wait for one to be made. */
  PENDING("pending")
}

internal sealed interface PathDecision {
  data class Direct(val identity: IdentityKind) : PathDecision

  data class Viewer(val reason: ViewerReason) : PathDecision

  /** A probe has to run before the path is known. */
  data object Probe : PathDecision
}

/** Why a direct attempt failed; certificate and authorization problems are shown to the person. */
internal enum class FailureKind(val code: String, val shown: Boolean) {
  /** The agent's certificate was refused by the app. */
  CERTIFICATE("certificate", true),

  /** The agent refused the phone: no admission for the enrolled identity. */
  AUTHORIZATION("authorization", true),
  UNREACHABLE("unreachable", false),
  TIMEOUT("timeout", false),
  UNEXPECTED("unexpected", false)
}

internal data class DirectFailure(val kind: FailureKind, val detail: String, val at: Long)

internal sealed interface ProbeRecord {
  val epoch: Long
  val place: String
  val at: Long

  data class Succeeded(
    override val epoch: Long,
    override val place: String,
    override val at: Long,
    val identity: IdentityKind,
    val leafFingerprint: String?
  ) : ProbeRecord

  data class Failed(
    override val epoch: Long,
    override val place: String,
    override val at: Long,
    val failure: DirectFailure
  ) : ProbeRecord
}

/**
 * The decision about each machine's path, with no threads or I/O. The hub gate, the cached trust
 * and routes and the probe results go in; a decision comes out.
 *
 * - Away from home, as the hub's own request saw it, no direct attempt is made.
 * - Otherwise (home, or no hub answer since the network changed) one probe runs per network change
 *   and per route, and a failed one keeps the machine on the viewer host for 60 s.
 * - After a week without a trust refresh the direct path is off; so is a route a week after the
 *   hub last reported it.
 */
internal class DirectPathModel(private val clock: () -> Long = System::currentTimeMillis) {
  var enrolled = false

  var trust: DirectTrust? = null
    private set

  var routes: Map<String, DirectRoute> = emptyMap()
    private set

  var gate = HubGate.UNKNOWN
    private set

  /** Counts network changes: a probe result belongs to the network it was made on. */
  var epoch = 0L
    private set

  private val probes = mutableMapOf<String, ProbeRecord>()
  private val shownFailures = mutableMapOf<String, DirectFailure>()

  fun restore(snapshot: DirectSnapshot) {
    trust = snapshot.trust
    routes = snapshot.routes
  }

  fun snapshot() = DirectSnapshot(trust, routes)

  fun decision(machine: String): PathDecision {
    val now = clock()
    val blocked = viewerReason(machine, now)
    if (blocked != null) return PathDecision.Viewer(blocked)
    val route = routes.getValue(machine)
    val probe = probes[machine]?.takeIf { it.epoch == epoch && it.place == route.place }
    return when {
      probe is ProbeRecord.Succeeded -> PathDecision.Direct(probe.identity)
      probe is ProbeRecord.Failed && now - probe.at < PROBE_FAILURE_CACHE_MS ->
        PathDecision.Viewer(ViewerReason.PROBE_FAILED)
      else -> PathDecision.Probe
    }
  }

  private fun viewerReason(machine: String, now: Long): ViewerReason? {
    val current = trust
    val route = routes[machine]
    return when {
      !enrolled -> ViewerReason.NOT_ENROLLED
      current == null -> ViewerReason.NO_TRUST
      current.expired(now) -> ViewerReason.TRUST_EXPIRED
      route == null -> ViewerReason.NO_ROUTE
      route.expired(now) -> ViewerReason.ROUTE_EXPIRED
      gate == HubGate.AWAY -> ViewerReason.AWAY
      else -> null
    }
  }

  /** The route to probe or dial for [machine], when the trust and the route are both in date. */
  fun routeFor(machine: String): DirectRoute? {
    val now = clock()
    val route = routes[machine]
    return route?.takeIf { enrolled && trust?.expired(now) == false && !it.expired(now) }
  }

  /** The record of the last probe of [machine] on this network, if it still applies. */
  fun probe(machine: String): ProbeRecord? =
    probes[machine]?.takeIf { it.epoch == epoch && it.place == routes[machine]?.place }

  /** The last failure worth showing for [machine], until the next success. */
  fun shownFailure(machine: String): DirectFailure? = shownFailures[machine]

  /** A probe that started on network [epoch] passed; one from an older network is dropped. */
  fun probeSucceeded(
    machine: String,
    epoch: Long,
    identity: IdentityKind,
    leafFingerprint: String?
  ) {
    val route = routes[machine] ?: return
    if (epoch != this.epoch) return
    probes[machine] = ProbeRecord.Succeeded(epoch, route.place, clock(), identity, leafFingerprint)
    shownFailures.remove(machine)
  }

  fun probeFailed(machine: String, epoch: Long, kind: FailureKind, detail: String) {
    val route = routes[machine] ?: return
    if (epoch != this.epoch) return
    val failure = DirectFailure(kind, detail, clock())
    probes[machine] = ProbeRecord.Failed(epoch, route.place, failure.at, failure)
    if (kind.shown) shownFailures[machine] = failure else shownFailures.remove(machine)
  }

  /**
   * A hub request answered: where the phone is, and (when it carried them) the routes it reports.
   * A machine the hub reports no route for keeps the one it had until that is a week old: the hub
   * has no route for a machine that lost its tunnel, though its listener may well be up at home.
   */
  fun hubAnswered(gate: HubGate, reported: Map<String, DirectRoute>?) {
    this.gate = gate
    if (reported != null) {
      val now = clock()
      routes = (routes + reported).filterValues { !it.expired(now) }
    }
  }

  fun trustRefreshed(next: DirectTrust) {
    val before = trust
    trust = next
    // A new CA or a revocation can make an agent that passed a probe fail now; probe again.
    val revokedLeaf = probes.filterValues {
      it is ProbeRecord.Succeeded && it.leafFingerprint in next.revoked
    }.keys
    if (before != null && before.caRevision != next.caRevision) probes.clear()
    revokedLeaf.forEach { probes.remove(it) }
  }

  /** The phone's network changed: the hub gate and every probe result are stale. */
  fun networkChanged() {
    epoch++
    gate = HubGate.UNKNOWN
    probes.clear()
  }

  /** A request on the direct path failed: the path is not trusted again until a probe passes. */
  fun directBroke(machine: String, kind: FailureKind, detail: String) {
    probeFailed(machine, epoch, kind, detail)
  }

  /** The device's identity changed: what a probe learned with the old one no longer applies. */
  fun clearProbes() {
    probes.clear()
  }

  fun forget() {
    trust = null
    routes = emptyMap()
    probes.clear()
    shownFailures.clear()
  }
}
