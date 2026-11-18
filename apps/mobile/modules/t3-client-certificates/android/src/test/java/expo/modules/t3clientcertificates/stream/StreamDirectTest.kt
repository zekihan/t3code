package expo.modules.t3clientcertificates.stream

import expo.modules.t3clientcertificates.direct.fingerprintOf
import expo.modules.t3clientcertificates.enroll.CLIENT_AUTH
import expo.modules.t3clientcertificates.enroll.DAY
import expo.modules.t3clientcertificates.enroll.SERVER_AUTH
import expo.modules.t3clientcertificates.enroll.TestCa
import expo.modules.t3clientcertificates.enroll.newKeyPair
import java.security.cert.X509Certificate
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamDirectTest {
  private val ca = TestCa("clients CA")
  private val host = "t3.z-arch.mesh.noqer.com"
  private val url = "https://$host/.well-known/t3/environment"

  private fun agent(
    identity: String = "agent-z-arch",
    usages: List<String> = listOf(SERVER_AUTH, CLIENT_AUTH),
    issuer: TestCa = ca,
    life: Long = 30 * DAY
  ): X509Certificate {
    val now = System.currentTimeMillis()
    return issuer.issue(
      newKeyPair().public,
      listOf("urn:noqer:mtls:clients:$identity"),
      notBefore = now - DAY,
      notAfter = now + life,
      usages = usages
    )
  }

  private fun policy(revoked: List<String> = emptyList()) =
    DirectStreamPolicy(DirectStream(1234, host, ca.certificatePem, revoked, "agent-z-arch"))

  @Test fun theMachinesAgentOnItsOwnHostIsAccepted() {
    assertTrue(policy().accepts(url, agent()))
    assertTrue(policy().accepts("wss://$host/ws", agent()))
    assertTrue(policy().accepts("https://${host.uppercase()}/", agent()))
  }

  @Test fun anyOtherHostIsRefusedEvenWithTheRightCertificate() {
    val leaf = agent()
    listOf(
      "https://localhost/favicon.ico",
      "https://t3.z-mac.mesh.noqer.com/",
      "https://hub.mesh.noqer.com/",
      "https://$host.evil.example/",
      "not a url",
      ""
    ).forEach { assertFalse(it, policy().accepts(it, leaf)) }
    assertFalse(policy().accepts(null, leaf))
  }

  @Test fun noCertificateIsRefused() {
    assertFalse(policy().accepts(url, null))
  }

  @Test fun aCertificateThatFailsTheAgentCheckIsRefused() {
    assertFalse(policy().accepts(url, agent(identity = "agent-z-mac")))
    assertFalse(policy().accepts(url, agent(usages = listOf(CLIENT_AUTH))))
    assertFalse(policy().accepts(url, agent(issuer = TestCa("another CA"))))
    assertFalse(policy().accepts(url, agent(life = -2 * DAY)))
  }

  @Test fun aRevokedLeafIsRefused() {
    val leaf = agent()
    assertFalse(policy(listOf(fingerprintOf(leaf))).accepts(url, leaf))
    assertTrue(policy(listOf(fingerprintOf(agent()))).accepts(url, leaf))
  }
}
