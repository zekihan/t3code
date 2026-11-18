package expo.modules.t3clientcertificates.enroll

import java.io.IOException
import java.net.SocketTimeoutException
import java.security.cert.CertPathValidatorException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLPeerUnverifiedException

/** Codes the JS side maps to messages; [EnrollmentException.message] is a usable default. */
internal object EnrollCode {
  const val INVALID_IDENTITY = "INVALID_IDENTITY"
  const val TOKEN_REQUIRED = "TOKEN_REQUIRED"
  const val NETWORK = "NETWORK"
  const val TLS = "TLS"
  const val NO_ENROLLMENT_OPEN = "NO_ENROLLMENT_OPEN"
  const val TOKEN_INVALID = "TOKEN_INVALID"
  const val TOKEN_IDENTITY = "TOKEN_IDENTITY"
  const val IDENTITY_NOT_ALLOWED = "IDENTITY_NOT_ALLOWED"
  const val CSR_REJECTED = "CSR_REJECTED"
  const val RATE_LIMITED = "RATE_LIMITED"
  const val ISSUANCE_FAILED = "ISSUANCE_FAILED"
  const val HUB_ERROR = "HUB_ERROR"
  const val BAD_REPLY = "BAD_REPLY"
  const val KEYSTORE = "KEYSTORE"
  const val REENROLL_REQUIRED = "REENROLL_REQUIRED"
  const val NOT_ENROLLED = "NOT_ENROLLED"
  const val BUSY = "BUSY"
}

internal class EnrollmentException(val code: String, message: String, cause: Throwable? = null) :
  Exception(message, cause)

internal fun enrollmentError(code: String, detail: String? = null, cause: Throwable? = null) =
  EnrollmentException(code, enrollmentMessage(code, detail), cause)

private val FIXED_MESSAGES =
  mapOf(
    EnrollCode.INVALID_IDENTITY to
      "Device names look like device-z-phone-mesh: lowercase letters, digits and hyphens, " +
      "starting with device- and ending with -mesh.",
    EnrollCode.TOKEN_REQUIRED to "Enter the enrollment token.",
    EnrollCode.NETWORK to
      "Could not reach mesh.noqer.com. Check the network connection and try again.",
    EnrollCode.TLS to
      "The TLS certificate of mesh.noqer.com did not check out. " +
      "Check the date and time on this phone and the network, then try again.",
    EnrollCode.NO_ENROLLMENT_OPEN to
      "The hub has no token open. " +
      "The token may have expired (15 minutes) or already been used. Ask for a new one.",
    EnrollCode.TOKEN_INVALID to
      "The hub does not recognize this token. " +
      "A token works once and for 15 minutes. Ask for a new one.",
    EnrollCode.TOKEN_IDENTITY to
      "It was made for another device or another kind of identity. " +
      "Ask for a token for this device's name.",
    EnrollCode.IDENTITY_NOT_ALLOWED to
      "The hub does not let this identity enroll: it is the wrong kind of identity " +
      "or it is disabled.",
    EnrollCode.RATE_LIMITED to
      "The hub allows only a few enrollment attempts every 10 minutes. Wait a while and try again.",
    EnrollCode.ISSUANCE_FAILED to
      "The hub could not issue the certificate. Ask for a new token and try again.",
    EnrollCode.REENROLL_REQUIRED to
      "The hub no longer accepts this device's certificate. " +
      "Re-enroll this device with a new token.",
    EnrollCode.NOT_ENROLLED to "This device is not enrolled.",
    EnrollCode.BUSY to "Another enrollment operation is running."
  )

internal fun enrollmentMessage(code: String, detail: String? = null): String =
  FIXED_MESSAGES[code]
    ?: when (code) {
      EnrollCode.CSR_REJECTED -> "The hub refused the certificate request${suffix(detail)}"
      EnrollCode.BAD_REPLY ->
        "The hub's answer was not a valid certificate for this device${suffix(detail)}"
      EnrollCode.KEYSTORE -> "The Android Keystore could not create or use the key${suffix(detail)}"
      else -> "The hub refused enrollment${suffix(detail)}"
    }

private fun suffix(detail: String?) = if (detail.isNullOrBlank()) "." else ": ${detail.trim()}."

/** The hub's `Reject` detail strings (`internal/hub/enroll/handler.go`) as codes. */
internal fun rejectCode(detail: String): String =
  when (detail.trim().lowercase()) {
    "invalid token" -> EnrollCode.TOKEN_INVALID
    "identity mismatch" -> EnrollCode.TOKEN_IDENTITY
    "identity not allowed" -> EnrollCode.IDENTITY_NOT_ALLOWED
    "invalid csr" -> EnrollCode.CSR_REJECTED
    "too many attempts" -> EnrollCode.RATE_LIMITED
    "issuance failed" -> EnrollCode.ISSUANCE_FAILED
    else -> EnrollCode.HUB_ERROR
  }

internal fun rejectException(reason: String, detail: String): EnrollmentException {
  val code = rejectCode(detail)
  return enrollmentError(code, detail.ifBlank { reason })
}

internal enum class EnrollPhase { CONNECT, HANDSHAKE, EXCHANGE }

private fun causes(error: Throwable): Sequence<Throwable> = generateSequence(error) { it.cause }

internal fun isCertificateFailure(error: Throwable) =
  causes(error).any {
    it is SSLPeerUnverifiedException || it is CertificateException ||
      it is CertPathValidatorException
  }

/**
 * Where a connection failure happened decides what it means. The hub completes the TLS handshake
 * for the enrollment ALPN only while a token is outstanding (`verifyPeer` in the hub), and in TLS
 * 1.3 its refusal reaches the client after the client's own handshake is done. So a TLS failure
 * that is not a certificate problem means no token is open.
 */
internal fun classifyTransportFailure(phase: EnrollPhase, error: Throwable): EnrollmentException =
  when {
    causes(error).any { it is SocketTimeoutException } ->
      enrollmentError(EnrollCode.NETWORK, cause = error)
    isCertificateFailure(error) -> enrollmentError(EnrollCode.TLS, cause = error)
    phase != EnrollPhase.CONNECT && causes(error).any { it is SSLException } ->
      enrollmentError(EnrollCode.NO_ENROLLMENT_OPEN, cause = error)
    error is IOException -> enrollmentError(EnrollCode.NETWORK, cause = error)
    else -> enrollmentError(EnrollCode.HUB_ERROR, error.message, error)
  }
