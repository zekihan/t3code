package expo.modules.t3clientcertificates.direct

import expo.modules.t3clientcertificates.enroll.DAY
import expo.modules.t3clientcertificates.enroll.NOW
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DirectModelTest {
  @Test fun viewerHostsAreExactlyTheMeshViewerNames() {
    assertEquals("z-arch", machineOfViewerHost("t3.z-arch.mesh.noqer.com"))
    assertNull(machineOfViewerHost("hub.mesh.noqer.com"))
    assertNull(machineOfViewerHost("t3.z-arch.mesh.noqer.com.evil.test"))
    assertNull(machineOfViewerHost("evil.t3.z-arch.mesh.noqer.com"))
    assertNull(machineOfViewerHost("T3.z-arch.mesh.noqer.com"))
    assertNull(machineOfViewerHost("t3.-bad.mesh.noqer.com"))
    assertNull(machineOfViewerHost(null))
  }

  @Test fun lanAddressesAreLiteralsInPrivateRangesOnly() {
    listOf(
      "192.168.2.41",
      "10.0.2.2",
      "172.16.0.1",
      "172.31.255.254",
      "169.254.1.1",
      "fd12:3456:789a:1::41"
    )
      .forEach { assertNotNull(it, parseLanAddress(it)) }
    listOf(
      "8.8.8.8", "127.0.0.1", "172.32.0.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1",
      "2001:db8::1", "192.168.2", "192.168.2.256", "192.168.02.1", "z-arch.lan",
      "t3.z-arch.mesh.noqer.com",
      "192.168.2.41%wlan0", "::ffff:192.168.2.1", "", " 192.168.2.41"
    ).forEach { assertNull(it, parseLanAddress(it)) }
  }

  @Test fun aRouteIsAcceptedOnlyForItsOwnMachineWithItsAgentIdentity() {
    val route = acceptRoute("z-arch", "192.168.2.41", 27443, "agent-z-arch", NOW)
    assertEquals(DirectRoute("z-arch", "192.168.2.41", 27443, "agent-z-arch", NOW), route)
    assertNull(acceptRoute("z-arch", "192.168.2.41", 27443, "agent-z-mac", NOW))
    assertNull(acceptRoute("z-arch", "192.168.2.41", 27443, "device-z-phone-mesh", NOW))
    assertNull(acceptRoute("z-arch", "192.168.2.41", 0, "agent-z-arch", NOW))
    assertNull(acceptRoute("z-arch", "192.168.2.41", 70000, "agent-z-arch", NOW))
    assertNull(acceptRoute("z-arch", "8.8.8.8", 27443, "agent-z-arch", NOW))
    assertNull(acceptRoute("z-arch", null, 27443, "agent-z-arch", NOW))
    assertNull(acceptRoute("z-arch", "192.168.2.41", null, "agent-z-arch", NOW))
    assertNull(acceptRoute("z-arch", "192.168.2.41", 27443, null, NOW))
  }

  @Test fun aRouteAndTrustExpireAfterExactlyAWeek() {
    val route = DirectRoute("z-arch", "192.168.2.41", 27443, "agent-z-arch", NOW)
    assertFalse(route.expired(NOW + 7 * DAY - 1))
    assertTrue(route.expired(NOW + 7 * DAY))
    val trust = DirectTrust("pem", "r1", emptySet(), NOW)
    assertFalse(trust.expired(NOW + 7 * DAY - 1))
    assertTrue(trust.expired(NOW + 7 * DAY))
  }

  @Test fun aTimestampFromTheFutureDoesNotKeepTrustAlive() {
    assertTrue(DirectTrust("pem", "r1", emptySet(), NOW + 30 * DAY).expired(NOW))
    assertTrue(
      DirectRoute("z-arch", "192.168.2.41", 1, "agent-z-arch", NOW + 30 * DAY).expired(NOW)
    )
  }

  @Test fun theSnapshotSurvivesTheCodec() {
    val snapshot =
      DirectSnapshot(
        DirectTrust("PEM", "rev-7", setOf("a".repeat(64), "b".repeat(64)), NOW),
        mapOf(
          "z-arch" to DirectRoute("z-arch", "192.168.2.41", 27443, "agent-z-arch", NOW - DAY),
          "z-mac" to DirectRoute("z-mac", "fd12:3456:789a:1::42", 27443, "agent-z-mac", NOW)
        )
      )
    assertEquals(snapshot, DirectSnapshotCodec.decode(DirectSnapshotCodec.encode(snapshot)))
  }

  @Test fun aStoredRouteIsCheckedAgainOnLoad() {
    val tampered =
      """{"v":1,"routes":{"z-arch":{"address":"8.8.8.8","port":27443,"identity":"agent-z-arch","savedAt":1},
      "z-mac":{"address":"192.168.2.42","port":27443,"identity":"agent-z-arch","savedAt":1}}}"""
    assertTrue(DirectSnapshotCodec.decode(tampered).routes.isEmpty())
  }

  @Test fun unreadableOrForeignStateIsAnEmptySnapshot() {
    val empty = DirectSnapshot(null, emptyMap())
    assertEquals(empty, DirectSnapshotCodec.decode(null))
    assertEquals(empty, DirectSnapshotCodec.decode(""))
    assertEquals(empty, DirectSnapshotCodec.decode("{not json"))
    assertEquals(empty, DirectSnapshotCodec.decode("""{"v":2,"routes":{}}"""))
  }
}
