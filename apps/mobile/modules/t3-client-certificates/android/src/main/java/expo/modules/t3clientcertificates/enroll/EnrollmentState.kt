package expo.modules.t3clientcertificates.enroll

import org.json.JSONException
import org.json.JSONObject

private const val DAY_MS = 24L * 60 * 60 * 1000

/** The device certificates last 8760 h; the app renews with this much left. */
internal const val RENEW_WITHIN_MS = 90 * DAY_MS

/** The previous key and certificate stay for the agents' cache window after a renewal. */
internal const val PREVIOUS_KEEP_MS = 7 * DAY_MS

/** A renewal check happens at most this often. */
internal const val CHECK_INTERVAL_MS = DAY_MS

/** A check that found no network does not use up the day; it may be tried again after this. */
internal const val OFFLINE_RETRY_MS = 60L * 60 * 1000

/** A key in the Android Keystore with the certificate the hub issued for it. */
internal data class Credential(
  val alias: String,
  val identity: String,
  val chainPem: String,
  val notBefore: Long,
  val notAfter: Long,
  val issuedAt: Long
)

/** The credential a renewal replaced, kept until [keepUntil] for the direct path (item 5). */
internal data class PreviousCredential(val credential: Credential, val keepUntil: Long)

internal data class EnrollmentState(
  val current: Credential,
  val previous: PreviousCredential?,
  val caBundlePem: String?,
  val caRevision: String?,
  /** When the last renewal check ran (epoch ms); 0 when none has. */
  val lastCheckAt: Long = 0,
  /** Why a renewal cannot proceed without re-enrolling: the hub refused the current leaf. */
  val reenrollReason: String? = null,
  val lastError: String? = null
)

/** True when a renewal should run: less than [RENEW_WITHIN_MS] of validity left. */
internal fun renewalDue(notAfter: Long, now: Long) = notAfter - now < RENEW_WITHIN_MS

/** When the renewal window opens. */
internal fun renewalOpensAt(notAfter: Long) = notAfter - RENEW_WITHIN_MS

/**
 * Whether a check may run now. A check that ran (or failed for a reason other than the network)
 * counts for a day; one that found no network only for an hour. [force] ignores both.
 */
internal fun checkAllowed(state: EnrollmentState, now: Long, force: Boolean): Boolean {
  if (force) return true
  val interval = if (state.lastError == OFFLINE_MARK) OFFLINE_RETRY_MS else CHECK_INTERVAL_MS
  return state.lastCheckAt == 0L || now - state.lastCheckAt >= interval || state.lastCheckAt > now
}

/** [EnrollmentState.lastError] when the last check could not reach the hub. */
internal const val OFFLINE_MARK = "offline"

/** The previous credential is dropped once its week is over. */
internal fun previousExpired(previous: PreviousCredential?, now: Long) =
  previous != null && now >= previous.keepUntil

private fun Credential.toJson() =
  JSONObject()
    .put("alias", alias)
    .put("identity", identity)
    .put("chain", chainPem)
    .put("notBefore", notBefore)
    .put("notAfter", notAfter)
    .put("issuedAt", issuedAt)

private fun JSONObject.toCredential() =
  Credential(
    alias = getString("alias"),
    identity = getString("identity"),
    chainPem = getString("chain"),
    notBefore = getLong("notBefore"),
    notAfter = getLong("notAfter"),
    issuedAt = getLong("issuedAt")
  )

internal object EnrollmentStateCodec {
  private const val VERSION = 1

  fun encode(state: EnrollmentState): String =
    JSONObject()
      .put("v", VERSION)
      .put("current", state.current.toJson())
      .apply {
        state.previous?.let {
          put(
            "previous",
            JSONObject().put("credential", it.credential.toJson()).put("keepUntil", it.keepUntil)
          )
        }
        state.caBundlePem?.let { put("caBundle", it) }
        state.caRevision?.let { put("caRevision", it) }
        state.reenrollReason?.let { put("reenroll", it) }
        state.lastError?.let { put("lastError", it) }
        put("lastCheckAt", state.lastCheckAt)
      }
      .toString()

  /** Null for anything that is not a state this version wrote. */
  fun decode(json: String?): EnrollmentState? =
    if (json.isNullOrEmpty()) {
      null
    } else {
      try {
        parse(JSONObject(json))
      } catch (_: JSONException) {
        null
      }
    }

  private fun parse(root: JSONObject): EnrollmentState? {
    if (root.getInt("v") != VERSION) return null
    val previous =
      root.optJSONObject("previous")?.let {
        PreviousCredential(it.getJSONObject("credential").toCredential(), it.getLong("keepUntil"))
      }
    return EnrollmentState(
      current = root.getJSONObject("current").toCredential(),
      previous = previous,
      caBundlePem = root.optStringOrNull("caBundle"),
      caRevision = root.optStringOrNull("caRevision"),
      lastCheckAt = root.optLong("lastCheckAt", 0),
      reenrollReason = root.optStringOrNull("reenroll"),
      lastError = root.optStringOrNull("lastError")
    )
  }
}
