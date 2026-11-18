package expo.modules.t3clientcertificates.stream

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamPolicyTest {
  private val environment = "https://t3.z-arch.mesh.noqer.com/hub/devices"
  private val alias = "z-phone"
  private val proceed = ClientCertificateDecision.Proceed(alias)
  private val cancel = ClientCertificateDecision.Cancel

  private fun decide(
    host: String?,
    port: Int,
    url: String? = environment,
    stored: String? = alias
  ) =
    decideClientCertificate(url, stored, host, port)

  @Test
  fun proceedsForTheEnvironmentsExactHostAndPort() {
    assertEquals(proceed, decide("t3.z-arch.mesh.noqer.com", 443))
  }

  @Test
  fun proceedsForTheDefaultPortWhenTheRequestReportsNone() {
    assertEquals(proceed, decide("t3.z-arch.mesh.noqer.com", -1))
    assertEquals(proceed, decide("t3.z-arch.mesh.noqer.com", 0))
  }

  @Test
  fun ignoresPathCaseAndTrailingDotOfTheHost() {
    assertEquals(proceed, decide("T3.Z-Arch.Mesh.Noqer.Com", 443))
    assertEquals(proceed, decide("t3.z-arch.mesh.noqer.com.", 443))
  }

  @Test
  fun followsAWebSocketUrlToTheSameOrigin() {
    assertEquals(
      proceed,
      decide("t3.z-arch.mesh.noqer.com", 443, "wss://t3.z-arch.mesh.noqer.com/ws")
    )
  }

  @Test
  fun matchesAnExplicitPort() {
    val url = "https://10.0.2.2:8443/"
    assertEquals(proceed, decide("10.0.2.2", 8443, url))
    assertEquals(cancel, decide("10.0.2.2", 443, url))
    assertEquals(cancel, decide("10.0.2.2", -1, url))
  }

  @Test
  fun matchesIpv6HostsWithOrWithoutBrackets() {
    val url = "https://[::1]:8443/"
    assertEquals(proceed, decide("::1", 8443, url))
    assertEquals(proceed, decide("[::1]", 8443, url))
    assertEquals(cancel, decide("::2", 8443, url))
  }

  @Test
  fun cancelsEveryOtherHost() {
    assertEquals(cancel, decide("t3.z-mac.mesh.noqer.com", 443))
    assertEquals(cancel, decide("mesh.noqer.com", 443))
    assertEquals(cancel, decide("evil.example", 443))
    // A parent or child of the environment's host is a different origin.
    assertEquals(cancel, decide("z-arch.mesh.noqer.com", 443))
    assertEquals(cancel, decide("x.t3.z-arch.mesh.noqer.com", 443))
    assertEquals(cancel, decide("t3.z-arch.mesh.noqer.com.evil.example", 443))
  }

  @Test
  fun cancelsEveryOtherPort() {
    assertEquals(cancel, decide("t3.z-arch.mesh.noqer.com", 8443))
    assertEquals(cancel, decide("t3.z-arch.mesh.noqer.com", 80))
  }

  @Test
  fun cancelsWithoutAStoredAliasOrAnEnvironment() {
    assertEquals(cancel, decide("t3.z-arch.mesh.noqer.com", 443, stored = null))
    assertEquals(cancel, decide("t3.z-arch.mesh.noqer.com", 443, stored = ""))
    assertEquals(cancel, decide("t3.z-arch.mesh.noqer.com", 443, url = null))
    assertEquals(cancel, decide(null, 443))
  }

  @Test
  fun cancelsForEnvironmentsThatCannotHaveACertificate() {
    assertEquals(
      cancel,
      decide("t3.z-arch.mesh.noqer.com", 443, "http://t3.z-arch.mesh.noqer.com/")
    )
    assertEquals(cancel, decide("t3.z-arch.mesh.noqer.com", 443, "not a url"))
    assertEquals(
      cancel,
      decide("t3.z-arch.mesh.noqer.com", 443, "https://user:pass@t3.z-arch.mesh.noqer.com/")
    )
  }

  @Test
  fun neverAnswersWithAnotherAliasThanTheStoredOne() {
    val decision = decide("t3.z-arch.mesh.noqer.com", 443, stored = "z-tablet")
    assertEquals(ClientCertificateDecision.Proceed("z-tablet"), decision)
  }

  @Test
  fun recognizesOnlyTheStreamProcessOfThisPackage() {
    val pkg = "com.noqer.t3mesh"
    assertTrue(isStreamProcessName("com.noqer.t3mesh:stream", pkg))
    assertFalse(isStreamProcessName("com.noqer.t3mesh", pkg))
    assertFalse(isStreamProcessName("com.noqer.t3mesh:other", pkg))
    assertFalse(isStreamProcessName("com.t3tools.t3code:stream", pkg))
    assertFalse(isStreamProcessName(null, pkg))
  }

  @Test
  fun allowsOnlyTheSyntheticDocumentAndBlank() {
    val base = "https://localhost/"
    assertTrue(navigationAllowed(base, base))
    assertTrue(navigationAllowed("about:blank", base))
    assertFalse(navigationAllowed("https://localhost/other", base))
    assertFalse(navigationAllowed("https://t3.z-arch.mesh.noqer.com/", base))
    assertFalse(navigationAllowed("file:///data/data/x", base))
    assertFalse(navigationAllowed("intent://x#Intent;end", base))
  }
}
