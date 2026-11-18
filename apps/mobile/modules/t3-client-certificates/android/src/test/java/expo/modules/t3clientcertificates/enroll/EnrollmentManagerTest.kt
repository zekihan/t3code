package expo.modules.t3clientcertificates.enroll

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class EnrollmentManagerTest {
  private val ca = TestCa()
  private var now = NOW
  private val keys = SoftwareKeyBackend()
  private val storage = MemoryStorage()
  private val hub = FakeHub(ca) { now }
  private val changes = mutableListOf<Boolean>()
  private val manager =
    EnrollmentManager(
      keys = keys,
      storage = storage,
      enroller = hub,
      renewer = { hub },
      clock = { now },
      onChanged = { changes += it }
    )
  private val phone = "device-z-phone-mesh"

  private fun enrolled(identity: String = phone, token: String = "tok"): EnrollmentState {
    hub.tokens[token] = identity
    return manager.enroll(identity, token)
  }

  private fun failure(block: () -> Unit): EnrollmentException {
    try {
      block()
    } catch (error: EnrollmentException) {
      return error
    }
    fail("no failure")
    throw AssertionError()
  }

  // ---- enrolling ----

  @Test fun enrollingStoresTheKeyTheCertificateAndTheCaBundle() {
    val state = enrolled()
    assertEquals(phone, state.current.identity)
    assertTrue(state.current.alias.startsWith(KEY_ALIAS_PREFIX))
    assertEquals(listOf(state.current.alias), keys.pairs.keys.toList())
    assertNull(state.previous)
    assertEquals(ca.certificatePem, state.caBundlePem)
    assertEquals("rev-1", state.caRevision)
    assertEquals(state, storage.state)
    assertEquals(NOW + 365 * DAY, state.current.notAfter)
    assertEquals(listOf(true), changes)
  }

  @Test fun theHubSawAValidRequestForTheKeyInTheKeystore() {
    val state = enrolled()
    val csr = hub.csrs.single()
    assertEquals(listOf("urn:noqer:mtls:clients:$phone"), csr.uriSans)
    assertEquals(
      keys.pairs.getValue(state.current.alias).public.encoded.toList(),
      csr.spki.toList()
    )
  }

  @Test fun theEnrolledMaterialIsTheKeystoreKeyAndTheIssuedChain() {
    val state = enrolled()
    val material = manager.material()!!
    assertEquals(state.current.alias, material.alias)
    assertEquals(keys.pairs.getValue(state.current.alias).private, material.key)
    assertEquals(2, material.chain.size)
    assertEquals(hub.issued.single(), material.chain.first())
  }

  @Test fun anInvalidIdentityNeverCreatesAKey() {
    for (bad in listOf("agent-z-mac", "z-phone", "device-z-phone", "")) {
      assertEquals(EnrollCode.INVALID_IDENTITY, failure { manager.enroll(bad, "tok") }.code)
    }
    assertTrue(keys.pairs.isEmpty())
    assertEquals(0, storage.saves)
  }

  @Test fun anEmptyTokenNeverCreatesAKey() {
    assertEquals(EnrollCode.TOKEN_REQUIRED, failure { manager.enroll(phone, "  ") }.code)
    assertTrue(keys.pairs.isEmpty())
  }

  @Test fun theTokenIsTrimmed() {
    hub.tokens["tok"] = phone
    manager.enroll(phone, "  tok\n")
    assertNotNull(storage.state)
  }

  @Test fun aRefusedTokenLeavesNoKeyAndNoState() {
    val error = failure { manager.enroll(phone, "never-issued") }
    assertEquals(EnrollCode.TOKEN_INVALID, error.code)
    assertTrue(keys.pairs.isEmpty())
    assertEquals(1, keys.deleted.size)
    assertNull(storage.state)
    assertTrue(changes.isEmpty())
  }

  @Test fun aTokenForAnotherIdentityIsRefusedAndTheKeyDeleted() {
    hub.tokens["tok"] = "device-z-tablet-mesh"
    assertEquals(EnrollCode.TOKEN_INVALID, failure { manager.enroll(phone, "tok") }.code)
    assertTrue(keys.pairs.isEmpty())
  }

  @Test fun aKeystoreFailureIsReportedAndNothingIsSent() {
    keys.failGenerate = IllegalStateException("no keymaster")
    assertEquals(EnrollCode.KEYSTORE, failure { manager.enroll(phone, "tok") }.code)
    assertTrue(hub.csrs.isEmpty())
  }

  @Test fun networkFailuresKeepTheStateAndDeleteTheNewKey() {
    hub.enrollFailure = enrollmentError(EnrollCode.NETWORK)
    assertEquals(EnrollCode.NETWORK, failure { manager.enroll(phone, "tok") }.code)
    assertTrue(keys.pairs.isEmpty())
  }

  private fun assertRejectsIssued(
    reason: String,
    tamper: (
      java.security.cert.X509Certificate,
      java.security.PublicKey
    ) -> java.security.cert.X509Certificate
  ) {
    hub.tokens["tok"] = phone
    hub.tamper = tamper
    val error = failure { manager.enroll(phone, "tok") }
    assertEquals(reason, EnrollCode.BAD_REPLY, error.code)
    assertTrue("$reason: the new key is deleted", keys.pairs.isEmpty())
    assertNull("$reason: nothing is stored", storage.state)
  }

  @Test fun aCertificateForAnotherIdentityIsNotAccepted() {
    assertRejectsIssued("identity") { _, key ->
      ca.issue(key, listOf("urn:noqer:mtls:clients:device-z-tablet-mesh"))
    }
    assertRejectsIssued("agent") { _, key ->
      ca.issue(key, listOf("urn:noqer:mtls:clients:agent-z-mac"))
    }
  }

  @Test fun aCertificateForAnotherKeyIsNotAccepted() {
    assertRejectsIssued("key") { _, _ ->
      ca.issue(newKeyPair().public, listOf("urn:noqer:mtls:clients:$phone"))
    }
  }

  @Test fun aCertificateWithExtraNamesIsNotAccepted() {
    assertRejectsIssued("dns") { _, key ->
      ca.issue(key, listOf("urn:noqer:mtls:clients:$phone"), dns = listOf("evil.example"))
    }
    assertRejectsIssued("two uris") { _, key ->
      ca.issue(key, listOf("urn:noqer:mtls:clients:$phone", "urn:noqer:mtls:clients:z-phone"))
    }
  }

  @Test fun anExpiredCertificateIsNotAccepted() {
    assertRejectsIssued("expired") { _, key ->
      ca.issue(
        key,
        listOf("urn:noqer:mtls:clients:$phone"),
        notBefore = NOW - 10 * DAY,
        notAfter =
          NOW - DAY
      )
    }
  }

  @Test fun anOversizedOrEmptyCaBundleIsHandled() {
    hub.caBundle = null
    hub.caRevision = null
    val state = enrolled()
    assertNull(state.caBundlePem)
    assertNull(state.caRevision)
  }

  // ---- re-enrolling and removing ----

  @Test fun reEnrollingReplacesTheIdentityAndDeletesTheOldKeysAtOnce() {
    val first = enrolled()
    hub.certificateLifetime = 400 * DAY
    now += DAY
    val renewed = manager.renew(force = true) as RenewOutcome.Renewed
    val oldCurrent = first.current.alias
    val oldPrevious = renewed.state.current.alias
    keys.deleted.clear()
    changes.clear()
    val second = enrolled("device-z-tablet-mesh", "tok2")
    assertEquals("device-z-tablet-mesh", second.current.identity)
    assertNull("the previous key goes at once", second.previous)
    assertEquals(setOf(oldCurrent, oldPrevious), keys.deleted.toSet())
    assertEquals(listOf(second.current.alias), keys.pairs.keys.toList())
    assertEquals(listOf(true), changes)
  }

  @Test fun aFailedReEnrollmentKeepsTheOldIdentity() {
    val first = enrolled()
    assertEquals(EnrollCode.TOKEN_INVALID, failure { manager.enroll(phone, "bad") }.code)
    assertEquals(first, storage.state)
    assertEquals(listOf(first.current.alias), keys.pairs.keys.toList())
  }

  @Test fun removingDeletesEveryKeyIncludingStrays() {
    enrolled()
    keys.generate(KEY_ALIAS_PREFIX + "stray")
    keys.foreign += "someone-elses-key"
    changes.clear()
    manager.remove()
    assertNull(storage.state)
    assertTrue(keys.pairs.isEmpty())
    assertEquals("keys this app did not create stay", listOf("someone-elses-key"), keys.foreign)
    assertEquals(listOf(true), changes)
    assertNull(manager.material())
  }

  // ---- renewing ----

  private fun enrolledNearExpiry(): EnrollmentState {
    hub.certificateLifetime = 60 * DAY
    return enrolled()
  }

  @Test fun aCertificateWithEnoughValidityIsNotRenewed() {
    enrolled()
    assertEquals(RenewOutcome.NotDue, manager.renew(force = false))
    assertEquals(1, hub.csrs.size)
    assertEquals("the check is recorded", NOW, storage.state!!.lastCheckAt)
  }

  @Test fun theCheckRunsAtMostOncePerDay() {
    enrolled()
    manager.renew(force = false)
    now += 23 * 60 * 60 * 1000L
    assertEquals(RenewOutcome.Throttled, manager.renew(force = false))
    now += 2 * 60 * 60 * 1000L
    assertEquals(RenewOutcome.NotDue, manager.renew(force = false))
  }

  @Test fun withUnderNinetyDaysLeftARenewalUsesANewKeyAndKeepsThePrevious() {
    val first = enrolledNearExpiry()
    hub.certificateLifetime = 365 * DAY
    now += DAY
    val result = manager.renew(force = false) as RenewOutcome.Renewed
    val state = result.state
    assertNotEquals(first.current.alias, state.current.alias)
    assertEquals(phone, state.current.identity)
    assertEquals(first.current, state.previous!!.credential)
    assertEquals(now + 7 * DAY, state.previous!!.keepUntil)
    assertEquals(
      "both keys exist",
      setOf(first.current.alias, state.current.alias),
      keys.pairs.keys
    )
    assertNotEquals(
      "a new key",
      hub.csrs[0].spki.toList(),
      hub.csrs[1].spki.toList()
    )
    assertEquals(state, storage.state)
    assertEquals(listOf(true, true), changes)
  }

  @Test fun theRenewalRequestIsTheSameKindOfRequest() {
    enrolledNearExpiry()
    manager.renew(force = false)
    val csr = hub.csrs.last()
    assertEquals(listOf("urn:noqer:mtls:clients:$phone"), csr.uriSans)
    assertEquals(0, csr.otherSans)
    assertTrue(verifiesCsr(csr))
  }

  @Test fun renewingMovesToTheNewMaterialAndTheOldOneStaysAvailableForAWeek() {
    val first = enrolledNearExpiry()
    hub.certificateLifetime = 365 * DAY
    manager.renew(force = false)
    val current = manager.material()!!
    assertNotEquals(first.current.alias, current.alias)
    assertEquals(first.current.alias, manager.previousMaterial()!!.alias)
    now += 7 * DAY - 1
    assertNotNull(manager.previousMaterial())
    now += 1
    assertNull("the week is over", manager.previousMaterial())
  }

  @Test fun aSecondRenewalDropsTheOlderPrevious() {
    val first = enrolledNearExpiry()
    hub.certificateLifetime = 60 * DAY
    now += DAY
    val second = (manager.renew(force = true) as RenewOutcome.Renewed).state
    now += DAY
    val third = (manager.renew(force = true) as RenewOutcome.Renewed).state
    assertEquals(second.current, third.previous!!.credential)
    assertFalse("the first key is gone", first.current.alias in keys.pairs)
    assertEquals(setOf(second.current.alias, third.current.alias), keys.pairs.keys)
  }

  @Test fun aNewCaBundleReplacesTheOldOneAndAMissingOneKeepsIt() {
    enrolledNearExpiry()
    hub.caBundle = TestCa("rotated").certificatePem
    hub.caRevision = "rev-2"
    now += DAY
    manager.renew(force = false)
    assertEquals("rev-2", storage.state!!.caRevision)
    assertEquals(hub.caBundle, storage.state!!.caBundlePem)
    hub.caBundle = null
    hub.caRevision = null
    hub.certificateLifetime = 60 * DAY
    now += DAY
    manager.renew(force = true)
    assertEquals("rev-2", storage.state!!.caRevision)
    assertEquals("rotated", true, storage.state!!.caBundlePem!!.isNotEmpty())
  }

  @Test fun aRenewalWithoutNetworkKeepsEverythingAndRetriesAfterAnHour() {
    val first = enrolledNearExpiry()
    hub.renewFailure = enrollmentError(EnrollCode.NETWORK)
    val failed = manager.renew(force = false) as RenewOutcome.Failed
    assertEquals(EnrollCode.NETWORK, failed.error.code)
    assertEquals(first.current, storage.state!!.current)
    assertEquals(listOf(first.current.alias), keys.pairs.keys.toList())
    assertEquals(OFFLINE_MARK, storage.state!!.lastError)
    now += OFFLINE_RETRY_MS - 1
    assertEquals(RenewOutcome.Throttled, manager.renew(force = false))
    hub.renewFailure = null
    now += 1
    assertTrue(manager.renew(force = false) is RenewOutcome.Renewed)
    assertNull(storage.state!!.lastError)
  }

  @Test fun aRefusedLeafMeansReEnrollment() {
    val first = enrolledNearExpiry()
    hub.renewFailure = enrollmentError(EnrollCode.REENROLL_REQUIRED)
    val failed = manager.renew(force = false) as RenewOutcome.Failed
    assertEquals(EnrollCode.REENROLL_REQUIRED, failed.error.code)
    assertEquals("refused", storage.state!!.reenrollReason)
    assertEquals(listOf(first.current.alias), keys.pairs.keys.toList())
    assertEquals("reenroll", manager.status()!!.state)
    // An automatic check does not ask the hub again; a forced one does, and clears the state.
    now += 2 * DAY
    hub.renewFailure = null
    hub.csrs.clear()
    assertEquals(
      EnrollCode.REENROLL_REQUIRED,
      (manager.renew(force = false) as RenewOutcome.Failed).error.code
    )
    assertTrue(hub.csrs.isEmpty())
    assertTrue(manager.renew(force = true) is RenewOutcome.Renewed)
    assertNull(storage.state!!.reenrollReason)
    assertEquals("valid", manager.status()!!.state)
  }

  @Test fun anExpiredLeafCannotBeRenewedAndNeedsReEnrollment() {
    enrolledNearExpiry()
    hub.csrs.clear()
    now += 61 * DAY
    val failed = manager.renew(force = false) as RenewOutcome.Failed
    assertEquals(EnrollCode.REENROLL_REQUIRED, failed.error.code)
    assertTrue("the hub was not asked", hub.csrs.isEmpty())
    assertEquals("expired", manager.status()!!.state)
  }

  @Test fun aBadRenewalAnswerKeepsTheOldIdentity() {
    val first = enrolledNearExpiry()
    hub.tamper = { _, _ -> ca.issue(newKeyPair().public, listOf("urn:noqer:mtls:clients:$phone")) }
    val failed = manager.renew(force = true) as RenewOutcome.Failed
    assertEquals(EnrollCode.BAD_REPLY, failed.error.code)
    assertEquals(first.current, storage.state!!.current)
    assertEquals(listOf(first.current.alias), keys.pairs.keys.toList())
  }

  @Test fun renewingWhenNotEnrolledDoesNothing() {
    assertEquals(RenewOutcome.NotEnrolled, manager.renew(force = true))
  }

  // ---- the week of overlap, and cleanup ----

  @Test fun thePreviousKeyIsDeletedAfterAWeek() {
    val first = enrolledNearExpiry()
    hub.certificateLifetime = 365 * DAY
    manager.renew(force = false)
    now += 7 * DAY - 1
    manager.purge()
    assertTrue("still kept", first.current.alias in keys.pairs)
    assertNotNull(storage.state!!.previous)
    now += 1
    changes.clear()
    manager.purge()
    assertFalse("deleted", first.current.alias in keys.pairs)
    assertNull(storage.state!!.previous)
    assertEquals("the identity in use did not change", listOf(false), changes)
  }

  @Test fun purgeDeletesKeysNothingRefersToButNotOthers() {
    enrolled()
    val stray = KEY_ALIAS_PREFIX + "interrupted"
    keys.generate(stray)
    keys.foreign += "another-app-key"
    manager.purge()
    assertFalse(stray in keys.pairs)
    assertEquals(listOf("another-app-key"), keys.foreign)
    assertEquals(1, keys.pairs.size)
  }

  @Test fun purgeWithNoEnrollmentDeletesStrayKeys() {
    keys.generate(KEY_ALIAS_PREFIX + "left-behind")
    manager.purge()
    assertTrue(keys.pairs.isEmpty())
  }

  // ---- status and the identity in use ----

  @Test fun statusDescribesTheIdentityAndWhenItRenews() {
    val state = enrolled()
    val status = manager.status()!!
    assertEquals(phone, status.identity)
    assertEquals("valid", status.state)
    assertEquals(state.current.notAfter, status.notAfter)
    assertEquals(state.current.notAfter - 90 * DAY, status.renewAt)
    assertFalse(status.renewalDue)
    assertEquals("tee", status.protection)
    assertFalse(status.exportable)
    assertNull(status.previous)
    assertEquals("rev-1", status.caRevision)
  }

  @Test fun statusShowsThePreviousKeyWhileItLasts() {
    enrolledNearExpiry()
    hub.certificateLifetime = 365 * DAY
    manager.renew(force = false)
    val previous = manager.status()!!.previous!!
    assertEquals(NOW + 60 * DAY, previous.notAfter)
    assertEquals(NOW + 7 * DAY, previous.keepUntil)
    now += 8 * DAY
    assertNull(manager.status()!!.previous)
  }

  @Test fun aMissingKeyIsReportedNotReplacedByAnotherSource() {
    val state = enrolled()
    keys.pairs.remove(state.current.alias)
    assertEquals("key-missing", manager.status()!!.state)
    try {
      manager.material()
      fail("presented an identity without its key")
    } catch (error: EnrolledUnavailable) {
      assertEquals("missing", error.state)
    }
  }

  @Test fun anExpiredCertificateIsNotPresented() {
    enrolledNearExpiry()
    now += 61 * DAY
    try {
      manager.material()
      fail("presented an expired certificate")
    } catch (error: EnrolledUnavailable) {
      assertEquals("expired", error.state)
    }
  }

  @Test fun aFreshCertificateIsPresentedDespiteAClockAFewMinutesBehind() {
    hub.certificateLifetime = 365 * DAY
    enrolled()
    now -= DAY + 60_000
    // the leaf's notBefore is a day before issue in the test CA; one minute short of that is fine
    assertNotNull(manager.material())
  }

  @Test fun notEnrolledMeansNoMaterial() {
    assertNull(manager.material())
    assertNull(manager.previousMaterial())
    assertNull(manager.status())
    assertFalse(manager.isEnrolled())
  }

  // ---- one operation at a time ----

  @Test fun aSecondEnrollmentWhileOneRunsIsRefusedAsBusy() {
    val inside = CountDownLatch(1)
    val proceed = CountDownLatch(1)
    hub.tokens["a"] = phone
    hub.beforeReply = {
      inside.countDown()
      proceed.await(5, TimeUnit.SECONDS)
    }
    val first = AtomicReference<Throwable?>(null)
    val thread = Thread { runCatching { manager.enroll(phone, "a") }.onFailure { first.set(it) } }
    thread.start()
    assertTrue(inside.await(5, TimeUnit.SECONDS))
    assertEquals(EnrollCode.BUSY, failure { manager.enroll("device-z-tablet-mesh", "b") }.code)
    assertEquals(
      EnrollCode.BUSY,
      (
        runCatching {
          manager.renew(force = true)
        }.exceptionOrNull() as EnrollmentException
        ).code
    )
    proceed.countDown()
    thread.join(5000)
    assertNull(first.get())
    assertNotNull(storage.state)
  }
}
