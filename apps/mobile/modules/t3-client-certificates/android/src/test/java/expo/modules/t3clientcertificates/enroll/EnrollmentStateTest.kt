package expo.modules.t3clientcertificates.enroll

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EnrollmentStateTest {
  private val credential =
    Credential("t3mesh-device-a", "device-z-phone-mesh", "PEM\n", NOW - DAY, NOW + 365 * DAY, NOW)
  private val state =
    EnrollmentState(
      current = credential,
      previous = PreviousCredential(credential.copy(alias = "t3mesh-device-old"), NOW + 7 * DAY),
      caBundlePem = "BUNDLE\n",
      caRevision = "rev-2",
      lastCheckAt = NOW - 5,
      reenrollReason = "refused",
      lastError = "offline"
    )

  @Test fun theStateRoundTripsThroughItsJson() {
    assertEquals(state, EnrollmentStateCodec.decode(EnrollmentStateCodec.encode(state)))
    val minimal = EnrollmentState(credential, null, null, null)
    assertEquals(minimal, EnrollmentStateCodec.decode(EnrollmentStateCodec.encode(minimal)))
  }

  @Test fun unreadableStateIsNoState() {
    assertNull(EnrollmentStateCodec.decode(null))
    assertNull(EnrollmentStateCodec.decode(""))
    assertNull(EnrollmentStateCodec.decode("{"))
    assertNull(EnrollmentStateCodec.decode("{\"v\":2,\"current\":{}}"))
    assertNull(EnrollmentStateCodec.decode("{\"v\":1}"))
    assertNotNull(EnrollmentStateCodec.decode(EnrollmentStateCodec.encode(state)))
  }

  @Test fun renewalOpensNinetyDaysBeforeExpiry() {
    val notAfter = NOW + 365 * DAY
    assertEquals(notAfter - 90 * DAY, renewalOpensAt(notAfter))
    assertFalse(renewalDue(notAfter, NOW))
    assertFalse("exactly 90 days left", renewalDue(notAfter, notAfter - 90 * DAY))
    assertTrue("89 days left", renewalDue(notAfter, notAfter - 89 * DAY))
    assertTrue("already expired", renewalDue(notAfter, notAfter + DAY))
  }

  @Test fun aCheckRunsAtMostOncePerDay() {
    val fresh = state.copy(lastCheckAt = 0, lastError = null)
    assertTrue("never checked", checkAllowed(fresh, NOW, force = false))
    val checked = state.copy(lastCheckAt = NOW, lastError = null)
    assertFalse("just checked", checkAllowed(checked, NOW + 1, force = false))
    assertFalse("23 hours later", checkAllowed(checked, NOW + 23 * 60 * 60 * 1000, force = false))
    assertTrue("a day later", checkAllowed(checked, NOW + CHECK_INTERVAL_MS, force = false))
    assertTrue("forced", checkAllowed(checked, NOW + 1, force = true))
    assertTrue("the clock went backwards", checkAllowed(checked, NOW - DAY, force = false))
  }

  @Test fun aCheckWithoutNetworkMayBeTriedAgainAfterAnHour() {
    val offline = state.copy(lastCheckAt = NOW, lastError = OFFLINE_MARK)
    assertFalse(checkAllowed(offline, NOW + OFFLINE_RETRY_MS - 1, force = false))
    assertTrue(checkAllowed(offline, NOW + OFFLINE_RETRY_MS, force = false))
  }

  @Test fun thePreviousCredentialLastsAWeek() {
    val previous = PreviousCredential(credential, NOW + PREVIOUS_KEEP_MS)
    assertEquals(7 * DAY, PREVIOUS_KEEP_MS)
    assertFalse(previousExpired(previous, NOW + 7 * DAY - 1))
    assertTrue(previousExpired(previous, NOW + 7 * DAY))
    assertFalse(previousExpired(null, NOW))
  }

  @Test fun errorCodesHaveMessagesAndTheHubsRejectDetailsMap() {
    val codes =
      listOf(
        EnrollCode.INVALID_IDENTITY, EnrollCode.TOKEN_REQUIRED, EnrollCode.NETWORK, EnrollCode.TLS,
        EnrollCode.NO_ENROLLMENT_OPEN, EnrollCode.TOKEN_INVALID, EnrollCode.TOKEN_IDENTITY,
        EnrollCode.IDENTITY_NOT_ALLOWED, EnrollCode.CSR_REJECTED, EnrollCode.RATE_LIMITED,
        EnrollCode.ISSUANCE_FAILED, EnrollCode.HUB_ERROR, EnrollCode.BAD_REPLY, EnrollCode.KEYSTORE,
        EnrollCode.REENROLL_REQUIRED, EnrollCode.NOT_ENROLLED, EnrollCode.BUSY
      )
    codes.forEach { assertTrue(it, enrollmentMessage(it, "detail").length > 10) }
    assertEquals(EnrollCode.TOKEN_INVALID, rejectCode("invalid token"))
    assertEquals(EnrollCode.TOKEN_IDENTITY, rejectCode("identity mismatch"))
    assertEquals(EnrollCode.IDENTITY_NOT_ALLOWED, rejectCode("identity not allowed"))
    assertEquals(EnrollCode.CSR_REJECTED, rejectCode("invalid CSR"))
    assertEquals(EnrollCode.RATE_LIMITED, rejectCode("too many attempts"))
    assertEquals(EnrollCode.ISSUANCE_FAILED, rejectCode("issuance failed"))
    assertEquals(EnrollCode.HUB_ERROR, rejectCode("enrollment failed"))
    assertTrue(
      rejectException("enroll-failed", "something new").message!!.contains("something new")
    )
  }
}
