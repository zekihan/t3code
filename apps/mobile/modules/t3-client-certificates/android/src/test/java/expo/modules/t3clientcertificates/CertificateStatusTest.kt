package expo.modules.t3clientcertificates

import java.util.Date
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CertificateStatusTest {
  private val day = 24L * 60 * 60 * 1000
  private val now = System.currentTimeMillis()

  private fun leaf(notBefore: Long, notAfter: Long) =
    HeldCertificate.Builder()
      .commonName("phone")
      .validityInterval(notBefore, notAfter)
      .build()
      .certificate

  @Test
  fun reportsLeafExpiryForAValidChain() {
    val certificate = leaf(now - day, now + 10 * day)
    val status = certificateStatus(arrayOf(certificate), true, Date(now))
    assertEquals("valid", status.state)
    assertTrue(status.usable)
    assertEquals(certificate.notAfter.time, status.notAfter)
  }

  @Test
  fun reportsAnExpiredLeafWithItsExpiry() {
    val certificate = leaf(now - 20 * day, now - day)
    val status = certificateStatus(arrayOf(certificate), true, Date(now))
    assertEquals("expired", status.state)
    assertFalse(status.usable)
    assertEquals(certificate.notAfter.time, status.notAfter)
  }

  @Test
  fun reportsACertificateThatIsNotYetValid() {
    val status = certificateStatus(arrayOf(leaf(now + day, now + 5 * day)), true, Date(now))
    assertEquals("invalid", status.state)
  }

  @Test
  fun treatsAMissingKeyOrChainAsMissing() {
    val certificate = leaf(now - day, now + day)
    assertEquals("missing", certificateStatus(arrayOf(certificate), false, Date(now)).state)
    assertEquals("missing", certificateStatus(null, true, Date(now)).state)
    assertEquals("missing", certificateStatus(emptyArray(), true, Date(now)).state)
    assertNull(certificateStatus(null, true, Date(now)).notAfter)
  }
}
