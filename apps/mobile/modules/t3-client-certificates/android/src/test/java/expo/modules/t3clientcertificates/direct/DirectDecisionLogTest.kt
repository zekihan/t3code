package expo.modules.t3clientcertificates.direct

import org.junit.Assert.assertEquals
import org.junit.Test

class DirectDecisionLogTest {
  @Test
  fun keeps_only_the_most_recent_entries_in_chronological_order() {
    var now = 0L
    val log = DirectDecisionLog({ ++now }, capacity = 2)

    log.record("network", "changed")
    log.record("home", "home")
    log.record("path", "direct", "dev")

    assertEquals(
      listOf(
        DirectDecision(2L, "home", "home", null),
        DirectDecision(3L, "path", "direct", viewerHost("dev"))
      ),
      log.snapshot()
    )
  }

  @Test
  fun a_snapshot_does_not_change_when_the_buffer_wraps() {
    val log = DirectDecisionLog({ 1L }, capacity = 1)
    log.record("network", "changed")
    val captured = log.snapshot()

    log.record("home", "failed")

    assertEquals(listOf(DirectDecision(1L, "network", "changed", null)), captured)
    assertEquals(listOf(DirectDecision(1L, "home", "failed", null)), log.snapshot())
  }
}
