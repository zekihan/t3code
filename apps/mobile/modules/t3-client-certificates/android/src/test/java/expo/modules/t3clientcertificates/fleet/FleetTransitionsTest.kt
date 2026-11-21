package expo.modules.t3clientcertificates.fleet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FleetTransitionsTest {
  private val healthy = FleetMachine(true, T3Health.REACHABLE, emptySet())
  private val offline = FleetMachine(false, T3Health.UNKNOWN, emptySet())
  private val broken = FleetMachine(true, T3Health.UNREACHABLE, emptySet())
  private val enrollment =
    FleetEnrollment(issuedAt = 10, needsReenrollment = false, renewalFailed = false)

  @Test
  fun firstPollRecordsExistingProblemsSilently() {
    val fleet = mapOf("one" to offline.copy(alerts = setOf("cert-expiry")))
    val first = fleetTransitions(null, fleet, enrollment.copy(needsReenrollment = true))

    assertEquals(FleetChanges(), first.changes)
    assertEquals(fleet, first.state.machines)
    assertEquals(first.state, FleetSnapshotCodec.decode(FleetSnapshotCodec.encode(first.state)))
  }

  @Test
  fun groupsOutagesRecoveriesAndNewAlertsAndDoesNotRepeatThem() {
    val initial = fleetTransitions(
      null,
      mapOf("one" to healthy, "two" to healthy, "three" to offline),
      enrollment
    ).state
    val fleet = mapOf(
      "one" to offline.copy(alerts = setOf("disconnected")),
      "two" to broken.copy(alerts = setOf("cert-expiry", "exposed")),
      "three" to healthy
    )
    val next = fleetTransitions(initial, fleet, enrollment)

    assertEquals(
      FleetChanges(
        down = listOf("one", "two"),
        back = listOf("three"),
        alerts = listOf("one", "two")
      ),
      next.changes
    )
    assertEquals(FleetChanges(), fleetTransitions(next.state, fleet, enrollment).changes)
  }

  @Test
  fun unknownHealthDuringReconnectDoesNotEndAnOutage() {
    val initial = fleetTransitions(null, mapOf("one" to broken), enrollment).state
    val down = fleetTransitions(initial, mapOf("one" to offline), enrollment)
    val reconnecting = fleetTransitions(
      down.state,
      mapOf("one" to healthy.copy(t3 = T3Health.UNKNOWN)),
      enrollment
    )
    assertEquals(listOf("one"), down.changes.down)
    assertEquals(FleetChanges(), reconnecting.changes)
    assertEquals(
      FleetChanges(back = listOf("one")),
      fleetTransitions(reconnecting.state, mapOf("one" to healthy), enrollment).changes
    )
  }

  @Test
  fun aTunnelWithoutT3CanRecoverAndDisappearingMachinesAreNotOutages() {
    val initial = fleetTransitions(
      null,
      mapOf("one" to offline, "two" to healthy),
      enrollment
    ).state
    val next = fleetTransitions(
      initial,
      mapOf("one" to healthy.copy(t3 = T3Health.ABSENT), "new" to offline),
      enrollment
    )
    assertEquals(FleetChanges(back = listOf("one")), next.changes)
  }

  @Test
  fun aClearedAlertCanReappear() {
    val alerted = mapOf("one" to healthy.copy(alerts = setOf("cert-expiry")))
    val initial = fleetTransitions(null, alerted, enrollment).state
    val clear = fleetTransitions(initial, mapOf("one" to healthy), enrollment)
    assertEquals(listOf("one"), fleetTransitions(clear.state, alerted, enrollment).changes.alerts)
  }

  @Test
  fun refusalSurvivesFetchFailuresAndSettlesAfterSuccessOrReplacement() {
    val initial = fleetTransitions(null, mapOf("one" to healthy), enrollment).state
    val refused = fleetTransitions(initial, null, enrollment, hubRefused = true)
    val unavailable = fleetTransitions(refused.state, null, enrollment)
    assertEquals(EnrollmentNotice.REENROLL, refused.changes.enrollment)
    assertEquals(initial.machines, refused.state.machines)
    assertEquals(FleetChanges(), unavailable.changes)
    assertEquals(refused.state, unavailable.state)
    val replaced = fleetTransitions(unavailable.state, null, enrollment.copy(issuedAt = 20))
    assertEquals(false, replaced.state.enrollment?.hubRefused)
    val recovered = fleetTransitions(unavailable.state, initial.machines, enrollment)
    assertEquals(false, recovered.state.enrollment?.hubRefused)
  }

  @Test
  fun renewalFailureAndReenrollmentOnlyNotifyOnEnteringTheCondition() {
    val initial = fleetTransitions(null, null, enrollment).state
    val failure = enrollment.copy(renewalFailed = true)
    val failed = fleetTransitions(initial, null, failure)
    assertEquals(EnrollmentNotice.RENEWAL_FAILED, failed.changes.enrollment)
    assertEquals(FleetChanges(), fleetTransitions(failed.state, null, failure).changes)
    val expired = fleetTransitions(failed.state, null, failure.copy(needsReenrollment = true))
    assertEquals(EnrollmentNotice.REENROLL, expired.changes.enrollment)
    assertNull(expired.state.machines)
    val firstFleet = fleetTransitions(expired.state, mapOf("one" to offline), enrollment)
    assertEquals(FleetChanges(), firstFleet.changes)
  }

  @Test
  fun parsesTheFleetWireShapeAndRejectsAnIncompleteSnapshot() {
    assertEquals(
      mapOf("one" to broken.copy(alerts = setOf("cert-expiry", "future-alert"))),
      parseFleet(
        """
        {"machines":[{"name":"one","online":true,"services":{"t3":{"state":"unreachable"}},
        "alerts":["cert-expiry","future-alert"]}]}
        """.trimIndent()
      )
    )
    assertNull(parseFleet("""{"machines":[{"name":"one","alerts":[]}]}"""))
    assertNull(
      parseFleet(
        """{"machines":[{"name":"one","online":true,"alerts":[]},{"name":"one","online":false,"alerts":[]}]}"""
      )
    )
  }
}
