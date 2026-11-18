package expo.modules.t3clientcertificates.direct

import expo.modules.t3clientcertificates.enroll.CLIENT_AUTH
import expo.modules.t3clientcertificates.enroll.DAY
import expo.modules.t3clientcertificates.enroll.NOW
import expo.modules.t3clientcertificates.enroll.SERVER_AUTH
import expo.modules.t3clientcertificates.enroll.TestCa
import expo.modules.t3clientcertificates.enroll.newKeyPair
import java.security.cert.X509Certificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class AgentTrustTest {
  private val ca = TestCa("clients CA")
  private val identity = "agent-z-arch"
  private val uri = "urn:noqer:mtls:clients:agent-z-arch"

  @Suppress("LongParameterList")
  private fun agent(
    uris: List<String> = listOf(uri),
    dns: List<String> = emptyList(),
    usages: List<String> = listOf(SERVER_AUTH, CLIENT_AUTH),
    issuer: TestCa = ca,
    notBefore: Long = NOW - DAY,
    notAfter: Long = NOW + 30 * DAY
  ): X509Certificate =
    issuer.issue(
      newKeyPair().public,
      uris,
      dns,
      usages = usages,
      notBefore = notBefore,
      notAfter = notAfter
    )

  private fun check(
    revoked: Set<String> = emptySet(),
    bundle: String = ca.certificatePem,
    now: Long = NOW
  ) = AgentCheck(bundle, revoked, identity) { now }

  private fun rejection(result: AgentCheckResult) = (result as AgentCheckResult.Rejected).failure

  @Test fun acceptsAnAgentCertificateIssuedByTheCaWithItsOwnIdentity() {
    val leaf = agent()
    val result = check().check(listOf(leaf))
    assertEquals(AgentCheckResult.Accepted(fingerprintOf(leaf)), result)
  }

  @Test fun acceptsAChainThatCarriesTheCaAfterTheLeaf() {
    val leaf = agent()
    assertTrue(check().check(listOf(leaf, ca.certificate)) is AgentCheckResult.Accepted)
  }

  @Test fun refusesAnotherAgentsIdentity() {
    val leaf = agent(uris = listOf("urn:noqer:mtls:clients:agent-z-mac"))
    assertEquals(AgentFailure.WRONG_IDENTITY, rejection(check().check(listOf(leaf))))
  }

  @Test fun refusesADeviceIdentityOnAnAgentListener() {
    val leaf = agent(uris = listOf("urn:noqer:mtls:clients:device-z-phone-mesh"))
    assertEquals(AgentFailure.WRONG_IDENTITY, rejection(check().check(listOf(leaf))))
  }

  @Test fun refusesACertificateWithNoUri() {
    val leaf = agent(uris = emptyList(), dns = listOf("z-arch.lan"))
    assertEquals(AgentFailure.WRONG_IDENTITY, rejection(check().check(listOf(leaf))))
  }

  @Test fun refusesTwoUrisEvenWhenOneIsTheExpectedIdentity() {
    val leaf = agent(uris = listOf(uri, "urn:noqer:mtls:clients:agent-z-mac"))
    assertEquals(AgentFailure.MULTIPLE_IDENTITIES, rejection(check().check(listOf(leaf))))
  }

  @Test fun refusesACertificateWithoutServerAuthUsage() {
    assertEquals(
      AgentFailure.NO_SERVER_AUTH,
      rejection(check().check(listOf(agent(usages = listOf(CLIENT_AUTH)))))
    )
    assertEquals(
      AgentFailure.NO_SERVER_AUTH,
      rejection(check().check(listOf(agent(usages = emptyList()))))
    )
  }

  @Test fun refusesARevokedLeafByItsFingerprint() {
    val leaf = agent()
    val revoked = setOf(fingerprintOf(leaf))
    assertEquals(AgentFailure.REVOKED, rejection(check(revoked = revoked).check(listOf(leaf))))
    val other = agent()
    assertTrue(check(revoked = revoked).check(listOf(other)) is AgentCheckResult.Accepted)
  }

  @Test fun refusesACertificateFromAnotherCa() {
    val stranger = TestCa("another CA")
    val leaf = agent(issuer = stranger)
    assertEquals(AgentFailure.NOT_TRUSTED, rejection(check().check(listOf(leaf))))
  }

  @Test fun acceptsEitherCaOfABundleDuringARollover() {
    val next = TestCa("next clients CA")
    val bundle = ca.certificatePem + next.certificatePem
    assertTrue(
      check(bundle = bundle).check(listOf(agent(issuer = next))) is AgentCheckResult.Accepted
    )
    assertTrue(check(bundle = bundle).check(listOf(agent())) is AgentCheckResult.Accepted)
  }

  @Test fun refusesAnExpiredAndANotYetValidCertificate() {
    val expired = agent(notBefore = NOW - 60 * DAY, notAfter = NOW - DAY)
    assertEquals(AgentFailure.NOT_TRUSTED, rejection(check().check(listOf(expired))))
    val early = agent(notBefore = NOW + DAY, notAfter = NOW + 30 * DAY)
    assertEquals(AgentFailure.NOT_TRUSTED, rejection(check().check(listOf(early))))
  }

  @Test fun refusesWhenTheBundleHasNoCertificates() {
    assertEquals(AgentFailure.NOT_TRUSTED, rejection(check(bundle = "").check(listOf(agent()))))
    assertEquals(
      AgentFailure.NOT_TRUSTED,
      rejection(check(bundle = "not pem").check(listOf(agent())))
    )
  }

  @Test fun refusesAnEmptyChain() {
    assertEquals(AgentFailure.NOT_TRUSTED, rejection(check().check(emptyList())))
  }

  @Test fun refusesTheCaCertificateItselfAsALeaf() {
    assertEquals(AgentFailure.NOT_TRUSTED, rejection(check().check(listOf(ca.certificate))))
  }

  @Test fun theHostNameIsNeverCompared() {
    // The certificate has no DNS name at all; the check still passes.
    assertTrue(agent().subjectAlternativeNames.none { it[0] == 2 })
    assertTrue(check().check(listOf(agent())) is AgentCheckResult.Accepted)
  }

  @Test fun theTrustManagerThrowsTheRefusalAndReportsEveryResult() {
    val seen = mutableListOf<AgentCheckResult>()
    val manager = AgentTrustManager({ check() }) { seen += it }
    manager.checkServerTrusted(arrayOf(agent()), "ECDHE_ECDSA")
    val wrong = agent(uris = listOf("urn:noqer:mtls:clients:agent-z-mac"))
    try {
      manager.checkServerTrusted(arrayOf(wrong), "ECDHE_ECDSA")
      fail("a wrong identity must be refused")
    } catch (error: AgentCheckException) {
      assertEquals(AgentFailure.WRONG_IDENTITY, error.rejected.failure)
    }
    assertEquals(2, seen.size)
    assertTrue(manager.acceptedIssuers.isEmpty())
  }

  @Test fun theTrustManagerRefusesEverythingWithoutCachedTrust() {
    val manager = AgentTrustManager({ null })
    try {
      manager.checkServerTrusted(arrayOf(agent()), "ECDHE_ECDSA")
      fail("no trust means no direct connection")
    } catch (error: AgentCheckException) {
      assertEquals(AgentFailure.NO_TRUST, error.rejected.failure)
    }
  }

  @Test fun theTrustManagerDoesNotCheckClients() {
    try {
      AgentTrustManager({ check() }).checkClientTrusted(arrayOf(agent()), "ECDHE_ECDSA")
      fail("client checks are not supported")
    } catch (_: java.security.cert.CertificateException) {
    }
  }
}
