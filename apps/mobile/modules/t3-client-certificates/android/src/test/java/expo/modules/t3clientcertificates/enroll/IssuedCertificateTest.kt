package expo.modules.t3clientcertificates.enroll

import java.security.PublicKey
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class IssuedCertificateTest {
  private val key = publicKeyOf(unhex(HubFixtures.SPKI_HEX))

  // Every argument has a default; each test names the one it changes.
  @Suppress("LongParameterList")
  private fun accept(
    certificate: String = HubFixtures.ISSUED_CERT_PEM,
    chain: String = HubFixtures.ISSUED_CHAIN_PEM,
    bundle: String? = null,
    identity: String = HubFixtures.IDENTITY,
    publicKey: PublicKey = key,
    now: Long = NOW
  ) = acceptIssued(IssuedReply(certificate, chain, bundle, null), identity, publicKey, now)

  private fun assertBadReply(block: () -> Unit): EnrollmentException {
    try {
      block()
    } catch (error: EnrollmentException) {
      assertEquals(EnrollCode.BAD_REPLY, error.code)
      return error
    }
    fail("accepted")
    throw AssertionError()
  }

  @Test fun acceptsWhatTheHubsIssuerProducesForTheHubsOwnRequest() {
    val issued = accept(bundle = HubFixtures.ISSUED_CHAIN_PEM)
    assertEquals(listOf(HubFixtures.URI), uriSans(issued.leaf).first)
    assertEquals(false, uriSans(issued.leaf).second)
    val notAfter = Instant.parse(HubFixtures.ISSUED_NOT_AFTER).toEpochMilli()
    assertEquals(notAfter, issued.leaf.notAfter.time)
    assertEquals("the leaf, then the CA", 2, issued.chain.size)
    assertEquals(issued.leaf, issued.chain.first())
    assertEquals(2, parseCertificates(issued.chainPem).size)
    assertEquals(HubFixtures.ISSUED_CHAIN_PEM, issued.caBundlePem)
  }

  @Test fun theChainIsStoredWithoutADuplicateOfTheLeaf() {
    val issued = accept(chain = HubFixtures.ISSUED_CERT_PEM + HubFixtures.ISSUED_CHAIN_PEM)
    assertEquals(2, issued.chain.size)
  }

  @Test fun anEmptyChainIsJustTheLeaf() {
    val issued = accept(chain = "")
    assertEquals(1, issued.chain.size)
    assertNull(issued.caBundlePem)
  }

  @Test fun anExpiredCertificateIsRefused() {
    val after = Instant.parse(HubFixtures.ISSUED_NOT_AFTER).toEpochMilli()
    assertBadReply { accept(now = after) }
  }

  @Test fun theCertificateMustBeForTheGeneratedKey() {
    val error = assertBadReply { accept(publicKey = newKeyPair().public) }
    assertTrue(error.message!!.contains("different key"))
  }

  @Test fun theCertificateMustNameTheRequestedIdentity() {
    assertBadReply { accept(identity = "device-z-tablet-mesh") }
  }

  @Test fun garbageIsABadReplyNotACrash() {
    val garbage = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"
    for (bad in listOf("", "garbage", garbage)) assertBadReply { accept(certificate = bad) }
  }

  @Test fun anUnreadableCaBundleIsABadReply() {
    assertBadReply { accept(bundle = "garbage") }
  }
}
