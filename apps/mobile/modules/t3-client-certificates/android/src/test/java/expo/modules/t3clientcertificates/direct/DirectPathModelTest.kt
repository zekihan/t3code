package expo.modules.t3clientcertificates.direct

import expo.modules.t3clientcertificates.enroll.DAY
import expo.modules.t3clientcertificates.enroll.NOW
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class DirectPathModelTest {
  private var now = NOW
  private val model = DirectPathModel { now }
  private val route = DirectRoute("z-arch", "192.168.2.41", 27443, "agent-z-arch", NOW)
  private fun trust(revision: String = "r1", revoked: Set<String> = emptySet(), at: Long = NOW) =
    DirectTrust("PEM", revision, revoked, at)

  private fun ready(gate: HubGate = HubGate.HOME) {
    model.enrolled = true
    model.trustRefreshed(trust())
    model.hubAnswered(gate, mapOf("z-arch" to route))
  }

  private fun decision() = model.decision("z-arch")

  private fun viewer(reason: ViewerReason) = PathDecision.Viewer(reason)

  @Test fun aDeviceThatIsNotEnrolledNeverGoesDirect() {
    model.trustRefreshed(trust())
    model.hubAnswered(HubGate.HOME, mapOf("z-arch" to route))
    assertEquals(viewer(ViewerReason.NOT_ENROLLED), decision())
  }

  @Test fun withoutTrustOrARouteThereIsNothingToTry() {
    model.enrolled = true
    assertEquals(viewer(ViewerReason.NO_TRUST), decision())
    model.trustRefreshed(trust())
    assertEquals(viewer(ViewerReason.NO_ROUTE), decision())
    model.hubAnswered(HubGate.HOME, mapOf("z-arch" to route))
    assertEquals(PathDecision.Probe, decision())
  }

  @Test fun theHubSayingAwayMeansNoDirectAttemptAtAll() {
    ready(HubGate.AWAY)
    assertEquals(viewer(ViewerReason.AWAY), decision())
    // Even a probe result from before cannot bring the direct path back while away.
    model.probeSucceeded("z-arch", model.epoch, IdentityKind.CURRENT, null)
    assertEquals(viewer(ViewerReason.AWAY), decision())
  }

  @Test fun theHubSayingHomeProbesOnceAndAPassedProbeIsTheDirectPath() {
    ready(HubGate.HOME)
    assertEquals(PathDecision.Probe, decision())
    model.probeSucceeded("z-arch", model.epoch, IdentityKind.CURRENT, "fp")
    assertEquals(PathDecision.Direct(IdentityKind.CURRENT), decision())
  }

  @Test fun withoutTheHubTheGateIsUnknownAndTheProbeDecides() {
    model.enrolled = true
    model.trustRefreshed(trust())
    model.restore(DirectSnapshot(trust(), mapOf("z-arch" to route)))
    assertEquals(HubGate.UNKNOWN, model.gate)
    assertEquals(PathDecision.Probe, decision())
  }

  @Test fun aFailedProbeKeepsTheViewerHostForSixtySecondsThenTriesAgain() {
    ready()
    model.probeFailed("z-arch", model.epoch, FailureKind.TIMEOUT, "slow")
    assertEquals(viewer(ViewerReason.PROBE_FAILED), decision())
    now += 59_999
    assertEquals(viewer(ViewerReason.PROBE_FAILED), decision())
    now += 1
    assertEquals(PathDecision.Probe, decision())
  }

  @Test fun aNetworkChangeForgetsTheGateTheProbesAndTheFailureCache() {
    ready()
    model.probeFailed("z-arch", model.epoch, FailureKind.TIMEOUT, "slow")
    model.networkChanged()
    assertEquals(HubGate.UNKNOWN, model.gate)
    assertEquals(PathDecision.Probe, decision())
    model.probeSucceeded("z-arch", model.epoch, IdentityKind.CURRENT, null)
    model.networkChanged()
    assertEquals(PathDecision.Probe, decision())
  }

  @Test fun aProbeThatStartedOnTheOldNetworkIsDropped() {
    ready()
    val started = model.epoch
    model.networkChanged()
    model.probeSucceeded("z-arch", started, IdentityKind.CURRENT, null)
    model.probeFailed("z-arch", started, FailureKind.TIMEOUT, "slow")
    assertEquals(PathDecision.Probe, decision())
    assertNull(model.probe("z-arch"))
  }

  @Test fun trustExpiresAWeekAfterTheLastRefresh() {
    ready()
    model.probeSucceeded("z-arch", model.epoch, IdentityKind.CURRENT, null)
    now = NOW + 7 * DAY - 1
    model.hubAnswered(HubGate.HOME, mapOf("z-arch" to route.copy(savedAt = now)))
    assertEquals(PathDecision.Direct(IdentityKind.CURRENT), decision())
    now = NOW + 7 * DAY
    assertEquals(viewer(ViewerReason.TRUST_EXPIRED), decision())
    model.trustRefreshed(trust(at = now))
    model.hubAnswered(HubGate.HOME, mapOf("z-arch" to route.copy(savedAt = now)))
    assertEquals(PathDecision.Direct(IdentityKind.CURRENT), decision())
  }

  @Test fun aRouteExpiresAWeekAfterTheHubLastReportedIt() {
    ready()
    model.probeSucceeded("z-arch", model.epoch, IdentityKind.CURRENT, null)
    now = NOW + 7 * DAY - 1
    model.trustRefreshed(trust(at = now))
    assertEquals(PathDecision.Direct(IdentityKind.CURRENT), decision())
    now = NOW + 7 * DAY
    model.trustRefreshed(trust(at = now))
    assertEquals(viewer(ViewerReason.ROUTE_EXPIRED), decision())
    assertNull(model.routeFor("z-arch"))
  }

  @Test fun aRouteTheHubStopsReportingIsKeptUntilItIsAWeekOld() {
    ready()
    model.probeSucceeded("z-arch", model.epoch, IdentityKind.CURRENT, null)
    // The machine lost its tunnel, so the hub has no route for it, but it may still be home.
    model.hubAnswered(HubGate.HOME, emptyMap())
    assertEquals(PathDecision.Direct(IdentityKind.CURRENT), decision())
    now = NOW + 7 * DAY - 1
    model.trustRefreshed(trust(at = now))
    model.hubAnswered(HubGate.HOME, emptyMap())
    assertEquals(PathDecision.Direct(IdentityKind.CURRENT), decision())
    now = NOW + 7 * DAY
    model.trustRefreshed(trust(at = now))
    model.hubAnswered(HubGate.HOME, emptyMap())
    assertEquals(viewer(ViewerReason.NO_ROUTE), decision())
  }

  @Test fun aRouteTheHubReportsAgainIsRefreshed() {
    ready()
    now = NOW + 6 * DAY
    model.trustRefreshed(trust(at = now))
    model.hubAnswered(HubGate.HOME, mapOf("z-arch" to route.copy(savedAt = now)))
    now = NOW + 8 * DAY
    model.trustRefreshed(trust(at = now))
    assertEquals(PathDecision.Probe, decision())
  }

  @Test fun aMovedRouteNeedsANewProbe() {
    ready()
    model.probeSucceeded("z-arch", model.epoch, IdentityKind.CURRENT, null)
    model.hubAnswered(HubGate.HOME, mapOf("z-arch" to route.copy(address = "192.168.2.99")))
    assertEquals(PathDecision.Probe, decision())
  }

  @Test fun aNewCaRevisionOrARevokedLeafNeedsANewProbe() {
    ready()
    model.probeSucceeded("z-arch", model.epoch, IdentityKind.CURRENT, "leaf")
    model.trustRefreshed(trust(revision = "r1"))
    assertEquals(PathDecision.Direct(IdentityKind.CURRENT), decision())
    model.trustRefreshed(trust(revision = "r2"))
    assertEquals(PathDecision.Probe, decision())
    model.probeSucceeded("z-arch", model.epoch, IdentityKind.CURRENT, "leaf")
    model.trustRefreshed(trust(revision = "r2", revoked = setOf("leaf")))
    assertEquals(PathDecision.Probe, decision())
  }

  @Test fun theIdentityThatPassedTheProbeIsTheOneThePathUses() {
    ready()
    model.probeSucceeded("z-arch", model.epoch, IdentityKind.PREVIOUS, null)
    assertEquals(PathDecision.Direct(IdentityKind.PREVIOUS), decision())
  }

  @Test fun aRequestThatBrokeOnTheDirectPathSendsTheMachineToTheViewerHost() {
    ready()
    model.probeSucceeded("z-arch", model.epoch, IdentityKind.CURRENT, null)
    model.directBroke("z-arch", FailureKind.UNREACHABLE, "reset")
    assertEquals(viewer(ViewerReason.PROBE_FAILED), decision())
  }

  @Test fun onlyCertificateAndAuthorizationFailuresAreShownAndAPassedProbeClearsThem() {
    ready()
    model.probeFailed("z-arch", model.epoch, FailureKind.TIMEOUT, "slow")
    assertNull(model.shownFailure("z-arch"))
    model.probeFailed("z-arch", model.epoch, FailureKind.CERTIFICATE, "wrong identity")
    assertEquals(FailureKind.CERTIFICATE, model.shownFailure("z-arch")?.kind)
    model.probeFailed("z-arch", model.epoch, FailureKind.AUTHORIZATION, "refused")
    assertEquals(FailureKind.AUTHORIZATION, model.shownFailure("z-arch")?.kind)
    model.probeSucceeded("z-arch", model.epoch, IdentityKind.CURRENT, null)
    assertNull(model.shownFailure("z-arch"))
  }

  @Test fun aShownFailureOutlivesTheFailureCacheAndTheNetwork() {
    ready()
    model.probeFailed("z-arch", model.epoch, FailureKind.CERTIFICATE, "revoked")
    now += 61_000
    model.networkChanged()
    assertNotNull(model.shownFailure("z-arch"))
  }

  @Test fun otherMachinesAreIndependent() {
    ready()
    model.hubAnswered(
      HubGate.HOME,
      mapOf(
        "z-arch" to route,
        "z-mac" to route.copy(machine = "z-mac", agentIdentity = "agent-z-mac")
      )
    )
    model.probeSucceeded("z-mac", model.epoch, IdentityKind.CURRENT, null)
    assertEquals(PathDecision.Direct(IdentityKind.CURRENT), model.decision("z-mac"))
    assertEquals(PathDecision.Probe, decision())
    assertEquals(viewer(ViewerReason.NO_ROUTE), model.decision("devbox"))
  }
}
