package expo.modules.t3clientcertificates.enroll

import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.t3clientcertificates.T3CertificateTransport
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

private const val TAG = "T3MeshEnrollment"

/**
 * Device enrollment for the Mesh screen: create a Keystore key, enroll with a one-time token,
 * renew and remove. The identity itself is used by [T3CertificateTransport] and the stream process.
 */
class T3MeshEnrollmentModule : Module() {
  private val io = Executors.newCachedThreadPool()
  private lateinit var transport: T3CertificateTransport

  override fun definition() = ModuleDefinition {
    Name("T3MeshEnrollment")
    Events("enrollmentChanged")
    OnCreate { create() }
    OnDestroy { destroy() }
    OnActivityEntersForeground { checkRenewal() }
    AsyncFunction("getEnrollment") { promise: Promise ->
      execute(promise) { promise.resolve(transport.enrollment.status()?.toMap()) }
    }
    AsyncFunction("enroll") { identity: String, token: String, promise: Promise ->
      execute(promise) {
        val state = transport.enrollment.enroll(identity, token)
        val status = transport.enrollment.status()
        logStatus("enrolled", status)
        promise.resolve(status?.toMap() ?: mapOf("identity" to state.current.identity))
      }
    }
    AsyncFunction("renew") { force: Boolean, promise: Promise ->
      execute(promise) {
        val outcome = transport.enrollment.renew(force)
        if (outcome is RenewOutcome.Renewed) logStatus("renewed", transport.enrollment.status())
        promise.resolve(outcome.toMap())
      }
    }
    AsyncFunction("remove") { promise: Promise ->
      execute(promise) {
        transport.enrollment.remove()
        promise.resolve(null)
      }
    }
    // The Mesh screen gives the viewer origins the hub listed; they use the enrolled identity.
    AsyncFunction("setMeshOrigins") { origins: List<String>, promise: Promise ->
      execute(promise) {
        transport.setMeshOrigins(origins)
        promise.resolve(null)
      }
    }
  }

  private fun create() {
    val context = requireNotNull(appContext.reactContext).applicationContext
    transport = T3CertificateTransport.install(context)
    transport.enrollmentStatusChanged = { sendEvent("enrollmentChanged", emptyMap<String, Any>()) }
    checkRenewal()
  }

  /** Drops what is no longer needed and renews when due: at start-up and whenever the app returns. */
  private fun checkRenewal() {
    if (!::transport.isInitialized) return
    try {
      io.execute {
        runCatching { transport.enrollment.purge() }
        val outcome = runCatching { transport.enrollment.renew(force = false) }.getOrNull()
        if (outcome is RenewOutcome.Renewed) logStatus("renewed", transport.enrollment.status())
      }
    } catch (_: RejectedExecutionException) {
      // The app is closing.
    }
  }

  // What an operator checks on a device: where the key lives, and that it cannot be read out.
  private fun logStatus(event: String, status: EnrollmentStatus?) {
    if (status == null) return
    Log.i(
      TAG,
      "$event ${status.identity} protection=${status.protection} exportable=${status.exportable} " +
        "notAfter=${status.notAfter}"
    )
  }

  private fun destroy() {
    if (::transport.isInitialized) transport.enrollmentStatusChanged = null
    io.shutdown()
  }

  @Suppress("TooGenericExceptionCaught") // Every failure must settle the JS promise.
  private fun execute(promise: Promise, block: () -> Unit) {
    try {
      io.execute {
        try {
          block()
        } catch (error: EnrollmentException) {
          promise.reject(error.code, error.message, error)
        } catch (error: Exception) {
          promise.reject("ENROLLMENT_ERROR", error.message, error)
        }
      }
    } catch (error: RejectedExecutionException) {
      promise.reject("ENROLLMENT_ERROR", "The app is closing.", error)
    }
  }
}

internal fun EnrollmentStatus.toMap(): Map<String, Any?> =
  mapOf(
    "identity" to identity,
    "issuedAt" to issuedAt,
    "notAfter" to notAfter,
    "renewAt" to renewAt,
    "state" to state,
    "renewalDue" to renewalDue,
    "protection" to protection,
    "exportable" to exportable,
    "previous" to previous?.let { mapOf("notAfter" to it.notAfter, "keepUntil" to it.keepUntil) },
    "caRevision" to caRevision,
    "lastCheckAt" to lastCheckAt,
    "lastError" to lastError
  )

internal fun RenewOutcome.toMap(): Map<String, Any?> =
  when (this) {
    RenewOutcome.NotEnrolled -> mapOf("outcome" to "not-enrolled")
    RenewOutcome.Throttled -> mapOf("outcome" to "throttled")
    RenewOutcome.NotDue -> mapOf("outcome" to "not-due")
    is RenewOutcome.Renewed -> mapOf("outcome" to "renewed")
    is RenewOutcome.Failed -> mapOf(
      "outcome" to "failed",
      "code" to error.code,
      "message" to error.message
    )
  }
