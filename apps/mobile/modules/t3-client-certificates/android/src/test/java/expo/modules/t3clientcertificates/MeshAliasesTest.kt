package expo.modules.t3clientcertificates

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MeshAliasesTest {
  private val origin = "https://t3.emu.mesh.noqer.com/"
  private val marker = meshMarker(origin)

  @Test
  fun assignsAnOriginWithNoAliasAndMarksIt() {
    val plan = planMeshAssign(emptyMap<String, String>(), origin, "hub")!!
    assertEquals(mapOf(origin to "hub", marker to "hub"), plan.puts)
    assertTrue(plan.aliasChanged)
  }

  @Test
  fun neverOverwritesAnAliasThePersonChose() {
    assertNull(planMeshAssign(mapOf(origin to "mine"), origin, "hub"))
  }

  @Test
  fun keepsAPersonsAliasEvenWhenItEqualsTheHubAlias() {
    assertNull(planMeshAssign(mapOf(origin to "hub"), origin, "hub"))
  }

  @Test
  fun followsAReplacedHubAliasOnlyWhileTheAppOwnsTheOrigin() {
    val plan = planMeshAssign(mapOf(origin to "old", marker to "old"), origin, "new")!!
    assertEquals(mapOf(origin to "new", marker to "new"), plan.puts)
    assertTrue(plan.aliasChanged)
  }

  @Test
  fun treatsAMarkerThatNoLongerMatchesAsThePersonsChoice() {
    assertNull(planMeshAssign(mapOf(origin to "mine", marker to "old"), origin, "hub"))
  }

  @Test
  fun anUnchangedAssignmentDoesNotMoveTheIdentity() {
    val plan = planMeshAssign(mapOf(origin to "hub", marker to "hub"), origin, "hub")!!
    assertFalse(plan.aliasChanged)
  }

  @Test
  fun releaseRemovesAnAliasTheAppAssigned() {
    val plan = planMeshRelease(mapOf(origin to "hub", marker to "hub"), origin)!!
    assertEquals(setOf(origin, marker), plan.removes)
    assertTrue(plan.aliasChanged)
  }

  @Test
  fun releaseKeepsAPersonsAliasAndDropsTheStaleMarker() {
    val plan = planMeshRelease(mapOf(origin to "mine", marker to "hub"), origin)!!
    assertEquals(setOf(marker), plan.removes)
    assertFalse(plan.aliasChanged)
  }

  @Test
  fun releaseDoesNothingForAnOriginTheAppNeverAssigned() {
    assertNull(planMeshRelease(mapOf(origin to "mine"), origin))
  }

  @Test
  fun listsEveryMarkedOrigin() {
    val other = "https://t3.other.mesh.noqer.com/"
    val stored =
      mapOf(
        origin to "hub",
        marker to "hub",
        meshMarker(other) to "hub",
        "https://hub.mesh.noqer.com/" to "hub"
      )
    assertEquals(setOf(origin, other), meshAssignedOrigins(stored).toSet())
  }

  @Test
  fun removingTheHubCertificateReleasesOnlyWhatTheAppAssigned() {
    val chosen = "https://t3.mine.mesh.noqer.com/"
    val stale = "https://t3.stale.mesh.noqer.com/"
    val stored =
      mapOf(
        origin to "hub",
        marker to "hub",
        chosen to "personal",
        meshMarker(stale) to "old",
        stale to "personal"
      )
    val plans = planMeshReleaseAll(stored)
    assertEquals(setOf(origin, stale), plans.keys)
    assertEquals(setOf(origin, marker), plans.getValue(origin).removes)
    assertEquals(setOf(meshMarker(stale)), plans.getValue(stale).removes)
    assertFalse(plans.getValue(stale).aliasChanged)
  }
}
