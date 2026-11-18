package expo.modules.t3clientcertificates.enroll

import java.security.GeneralSecurityException
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.cert.X509Certificate
import java.util.UUID
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** What the app presents for the enrolled identity: the Keystore key and the certificate chain. */
internal class EnrolledMaterial(
  val alias: String,
  val key: PrivateKey,
  val chain: Array<X509Certificate>
)

/** Why the enrolled identity cannot be presented, when it cannot. Never a reason to use KeyChain. */
internal class EnrolledUnavailable(
  val state: String
) : Exception("The enrolled identity is $state.")

internal sealed interface RenewOutcome {
  data object NotEnrolled : RenewOutcome

  /** A check already ran within its interval. */
  data object Throttled : RenewOutcome

  /** Enough validity is left. */
  data object NotDue : RenewOutcome

  data class Renewed(val state: EnrollmentState) : RenewOutcome

  data class Failed(val error: EnrollmentException) : RenewOutcome
}

/** The pieces of [EnrollmentStatus] that describe the credential kept after a renewal. */
internal data class PreviousStatus(val notAfter: Long, val keepUntil: Long)

/** What the Mesh screen shows. */
internal data class EnrollmentStatus(
  val identity: String,
  val issuedAt: Long,
  val notAfter: Long,
  /** When the renewal window opens (90 days before expiry). */
  val renewAt: Long,
  /** "valid", "expired", "reenroll" (the hub refused the leaf) or "key-missing". */
  val state: String,
  val renewalDue: Boolean,
  val protection: String,
  val exportable: Boolean,
  val previous: PreviousStatus?,
  val caRevision: String?,
  val lastCheckAt: Long,
  val lastError: String?
)

/**
 * Owns the enrolled identity: the Keystore key, the issued certificate, the previous key kept
 * after a renewal, and the rules for replacing them. Operations that change it run one at a time;
 * every change is committed in one write before an old key is deleted, so a crash leaves either
 * the old identity or the new one, plus at most an unreferenced key that [purge] deletes.
 */
internal class EnrollmentManager(
  private val keys: KeyBackend,
  private val storage: EnrollmentStorage,
  private val enroller: EnrollExchange,
  private val renewer: () -> RenewExchange,
  private val clock: () -> Long = System::currentTimeMillis,
  /** Called after a change commits; true when the key or certificate in use changed. */
  private val onChanged: (identityChanged: Boolean) -> Unit = {}
) {
  private val operation = ReentrantLock()

  @Volatile private var cached: Cached? = null

  private class Cached(val state: EnrollmentState?, val chain: Array<X509Certificate>?)

  private fun snapshot(): Cached =
    cached
      ?: synchronized(this) {
        cached
          ?: storage.load().let { Cached(it, it?.let(::parseChain)) }.also { cached = it }
      }

  private fun parseChain(state: EnrollmentState) =
    try {
      parseCertificates(state.current.chainPem).toTypedArray().takeIf { it.isNotEmpty() }
    } catch (_: GeneralSecurityException) {
      null
    }

  fun state(): EnrollmentState? = snapshot().state

  fun isEnrolled() = snapshot().state != null

  // Saved and dropped from the cache together: a reader loading the old state cannot cache it after.
  private fun commit(state: EnrollmentState?) {
    synchronized(this) {
      storage.save(state)
      cached = null
    }
  }

  /** The identity to present, or null when the device is not enrolled. Never reads KeyChain. */
  fun material(): EnrolledMaterial? {
    val snapshot = snapshot()
    val state = snapshot.state ?: return null
    val chain = snapshot.chain
    val key = keys.privateKey(state.current.alias)
    if (key == null || chain == null) throw EnrolledUnavailable("missing")
    val status = expiryState(chain, clock())
    if (status != "valid") throw EnrolledUnavailable(status)
    return EnrolledMaterial(state.current.alias, key, chain)
  }

  /** The previous key and certificate while their week lasts, for the direct path (item 5). */
  fun previousMaterial(): EnrolledMaterial? =
    state()?.previous?.takeUnless { previousExpired(it, clock()) }?.let { previous ->
      val key = keys.privateKey(previous.credential.alias)
      val chain = parseCertificates(previous.credential.chainPem).toTypedArray()
      if (key == null ||
        chain.isEmpty()
      ) {
        null
      } else {
        EnrolledMaterial(previous.credential.alias, key, chain)
      }
    }

  fun status(): EnrollmentStatus? {
    val state = state() ?: return null
    val now = clock()
    val current = state.current
    val hasKey = keys.privateKey(current.alias) != null
    val derived =
      when {
        !hasKey -> "key-missing"
        current.notAfter <= now -> "expired"
        state.reenrollReason != null -> "reenroll"
        else -> "valid"
      }
    return EnrollmentStatus(
      identity = current.identity,
      issuedAt = current.issuedAt,
      notAfter = current.notAfter,
      renewAt = renewalOpensAt(current.notAfter),
      state = derived,
      renewalDue = renewalDue(current.notAfter, now),
      protection = if (hasKey) keys.protection(current.alias).wire else KeyProtection.UNKNOWN.wire,
      exportable = hasKey && keys.exportable(current.alias),
      previous =
        state.previous?.takeUnless { previousExpired(it, now) }?.let {
          PreviousStatus(it.credential.notAfter, it.keepUntil)
        },
      caRevision = state.caRevision,
      lastCheckAt = state.lastCheckAt,
      lastError = state.lastError
    )
  }

  /**
   * Enrolls with [token] under [identity]. A re-enrollment replaces the current identity once the
   * hub answered, and deletes the old key and the previous one at once.
   */
  fun enroll(identity: String, token: String): EnrollmentState {
    if (!isValidDeviceIdentity(identity)) throw enrollmentError(EnrollCode.INVALID_IDENTITY)
    val trimmed = token.trim()
    if (trimmed.isEmpty()) throw enrollmentError(EnrollCode.TOKEN_REQUIRED)
    return exclusively {
      val alias = newAlias()
      var committed = false
      try {
        val publicKey = generate(alias)
        val reply = enroller.exchange(trimmed, signedCsr(alias, publicKey, identity))
        val issued =
          acceptIssued(
            IssuedReply(reply.certificate, reply.chain, reply.caBundle, reply.caRevision),
            identity,
            publicKey,
            clock()
          )
        val old = storage.load()
        val state =
          EnrollmentState(
            current = credentialOf(alias, identity, issued),
            previous = null,
            caBundlePem = issued.caBundlePem,
            caRevision = issued.caRevision
          )
        commit(state)
        committed = true
        deleteQuietly(old?.current?.alias, old?.previous?.credential?.alias)
        onChanged(true)
        state
      } finally {
        if (!committed) deleteQuietly(alias)
      }
    }
  }

  /**
   * Renews when less than 90 days remain (or [force]). A check runs at most daily unless forced.
   * Every outcome is recorded, so the screen can show it and the next check can be scheduled.
   */
  fun renew(force: Boolean): RenewOutcome =
    exclusively {
      val state = storage.load() ?: return@exclusively RenewOutcome.NotEnrolled
      val now = clock()
      when {
        !checkAllowed(state, now, force) -> RenewOutcome.Throttled
        now >= state.current.notAfter -> refused(state, "expired", now)
        !force && state.reenrollReason != null -> RenewOutcome.Failed(
          enrollmentError(EnrollCode.REENROLL_REQUIRED)
        )
        !force && !renewalDue(state.current.notAfter, now) -> {
          commit(state.copy(lastCheckAt = now, lastError = null))
          onChanged(false)
          RenewOutcome.NotDue
        }
        else -> attemptRenewal(state, now)
      }
    }

  private fun attemptRenewal(state: EnrollmentState, now: Long): RenewOutcome {
    val alias = newAlias()
    var committed = false
    try {
      val publicKey = generate(alias)
      val reply = renewer().renew(signedCsr(alias, publicKey, state.current.identity))
      val issued =
        acceptIssued(
          IssuedReply(reply.certificate, reply.chain, reply.caBundle, reply.caRevision),
          state.current.identity,
          publicKey,
          now
        )
      val next =
        EnrollmentState(
          current = credentialOf(alias, state.current.identity, issued),
          previous = PreviousCredential(state.current, now + PREVIOUS_KEEP_MS),
          caBundlePem = issued.caBundlePem ?: state.caBundlePem,
          caRevision = if (issued.caBundlePem != null) issued.caRevision else state.caRevision,
          lastCheckAt = now
        )
      commit(next)
      committed = true
      deleteQuietly(state.previous?.credential?.alias)
      onChanged(true)
      return RenewOutcome.Renewed(next)
    } catch (error: EnrollmentException) {
      return if (error.code ==
        EnrollCode.REENROLL_REQUIRED
      ) {
        refused(state, "refused", now)
      } else {
        failed(state, error, now)
      }
    } finally {
      if (!committed) deleteQuietly(alias)
    }
  }

  private fun refused(state: EnrollmentState, reason: String, now: Long): RenewOutcome {
    commit(state.copy(reenrollReason = reason, lastCheckAt = now, lastError = null))
    onChanged(false)
    return RenewOutcome.Failed(enrollmentError(EnrollCode.REENROLL_REQUIRED))
  }

  private fun failed(state: EnrollmentState, error: EnrollmentException, now: Long): RenewOutcome {
    val mark = if (error.code == EnrollCode.NETWORK) OFFLINE_MARK else error.code
    commit(state.copy(lastCheckAt = now, lastError = mark))
    onChanged(false)
    return RenewOutcome.Failed(error)
  }

  /** Forgets the enrolled identity and deletes its keys. The KeyChain choices are untouched. */
  fun remove() {
    whenIdle {
      val old = storage.load()
      commit(null)
      deleteQuietly(old?.current?.alias, old?.previous?.credential?.alias)
      deleteOrphans(null)
      onChanged(true)
    }
  }

  /** Drops a previous key whose week is over and any key nothing refers to. Safe to run at any time. */
  fun purge() {
    whenIdle {
      var state = storage.load()
      if (state != null && previousExpired(state.previous, clock())) {
        val expired = state.previous
        state = state.copy(previous = null)
        commit(state)
        deleteQuietly(expired?.credential?.alias)
        onChanged(false)
      }
      deleteOrphans(state)
    }
  }

  private fun deleteOrphans(state: EnrollmentState?) {
    val referenced = setOfNotNull(state?.current?.alias, state?.previous?.credential?.alias)
    keys.aliases().filter {
      it.startsWith(KEY_ALIAS_PREFIX) && it !in referenced
    }.forEach { deleteQuietly(it) }
  }

  private fun credentialOf(alias: String, identity: String, issued: IssuedCertificate) =
    Credential(
      alias = alias,
      identity = identity,
      chainPem = issued.chainPem,
      notBefore = issued.leaf.notBefore.time,
      notAfter = issued.leaf.notAfter.time,
      issuedAt = clock()
    )

  // The Keystore reports unusable hardware as a ProviderException, which is a RuntimeException.
  @Suppress("TooGenericExceptionCaught")
  private fun generate(alias: String): PublicKey =
    try {
      keys.generate(alias)
    } catch (error: GeneralSecurityException) {
      throw enrollmentError(EnrollCode.KEYSTORE, error.message, error)
    } catch (error: RuntimeException) {
      throw enrollmentError(EnrollCode.KEYSTORE, error.message, error)
    }

  private fun signedCsr(alias: String, publicKey: PublicKey, identity: String): String {
    val key =
      keys.privateKey(alias) ?: throw enrollmentError(EnrollCode.KEYSTORE, "the new key is missing")
    return try {
      csrPem(
        buildCsr(publicKey, identity) { tbs ->
          Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(tbs)
            sign()
          }
        }
      )
    } catch (error: GeneralSecurityException) {
      throw enrollmentError(EnrollCode.KEYSTORE, error.message, error)
    }
  }

  @Suppress("TooGenericExceptionCaught") // A key that cannot be deleted now is deleted by purge.
  private fun deleteQuietly(vararg aliases: String?) {
    aliases.filterNotNull().forEach { alias ->
      try {
        keys.delete(alias)
      } catch (_: GeneralSecurityException) {
        // The entry stays unreferenced; purge tries again.
      } catch (_: RuntimeException) {
        // Same.
      }
    }
  }

  private fun newAlias() = KEY_ALIAS_PREFIX + UUID.randomUUID()

  private fun <T> exclusively(block: () -> T): T {
    if (!operation.tryLock()) throw enrollmentError(EnrollCode.BUSY)
    try {
      return block()
    } finally {
      operation.unlock()
    }
  }

  /** Waits for a running operation instead of refusing; for the quick start-up cleanup. */
  fun <T> whenIdle(block: () -> T): T = operation.withLock(block)
}

/** A clock a few minutes behind the hub must not make a fresh certificate "not yet valid". */
private const val CLOCK_SKEW_MS = 5L * 60 * 1000

/** "valid", "expired" or "invalid" (not yet valid) for a chain, like [certificateStatus]. */
internal fun expiryState(chain: Array<X509Certificate>, now: Long): String =
  when {
    chain.any { it.notAfter.time <= now } -> "expired"
    chain.any { it.notBefore.time - CLOCK_SKEW_MS > now } -> "invalid"
    else -> "valid"
  }
