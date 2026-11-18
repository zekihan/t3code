package expo.modules.t3clientcertificates.direct

import expo.modules.t3clientcertificates.enroll.parseCertificates
import java.security.GeneralSecurityException
import java.security.MessageDigest
import java.security.cert.CertPathValidator
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.CertificateParsingException
import java.security.cert.PKIXParameters
import java.security.cert.TrustAnchor
import java.security.cert.X509Certificate
import java.util.Date
import javax.net.ssl.X509TrustManager

private const val SERVER_AUTH_OID = "1.3.6.1.5.5.7.3.1"
private const val URI_NAME_TYPE = 6

/** Why the certificate a direct peer presented was refused. [code] is what the app reports. */
internal enum class AgentFailure(val code: String, val message: String) {
  NO_TRUST("no-trust", "The app has no trust information for the mesh CA."),
  NOT_TRUSTED("not-trusted", "The agent's certificate was not issued by the mesh CA."),
  NO_SERVER_AUTH("no-server-auth", "The agent's certificate is not valid for server use."),
  WRONG_IDENTITY("wrong-identity", "The agent's certificate names another identity."),
  MULTIPLE_IDENTITIES("multiple-identities", "The agent's certificate names several identities."),
  REVOKED("revoked", "The agent's certificate was revoked.")
}

internal sealed interface AgentCheckResult {
  data class Accepted(val leafFingerprint: String) : AgentCheckResult

  data class Rejected(val failure: AgentFailure, val detail: String) : AgentCheckResult
}

/** The failure a [AgentTrustManager] throws, so a handshake error can be told from a network one. */
internal class AgentCheckException(val rejected: AgentCheckResult.Rejected) :
  CertificateException("${rejected.failure.message} (${rejected.detail})")

internal fun fingerprintOf(certificate: X509Certificate): String =
  MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") {
    "%02x".format(it)
  }

/**
 * What the app accepts from an agent before sending T3 credentials: a certificate that chains to
 * the cached clients CA bundle, has `server auth` usage and exactly one URI, the expected
 * `agent-<machine>`, and is not on the revocation list. The host name is never compared, because
 * the connection goes to a LAN address under the viewer host's name.
 */
internal class AgentCheck(
  caBundlePem: String,
  private val revoked: Set<String>,
  private val expectedIdentity: String,
  private val clock: () -> Long = System::currentTimeMillis
) {
  private val anchors: List<X509Certificate> = parseBundle(caBundlePem)
  private val expectedUri = agentUriOf(expectedIdentity)

  fun check(chain: List<X509Certificate>): AgentCheckResult {
    val leaf = chain.firstOrNull() ?: return rejected(AgentFailure.NOT_TRUSTED, "no certificate")
    val problem = chainProblem(chain)
    val uris = uriNames(leaf)
    return when {
      problem != null -> rejected(AgentFailure.NOT_TRUSTED, problem)
      !allowsServerAuth(leaf) -> rejected(AgentFailure.NO_SERVER_AUTH, "no server auth usage")
      uris == null -> rejected(AgentFailure.WRONG_IDENTITY, "unreadable names")
      uris.size > 1 -> rejected(AgentFailure.MULTIPLE_IDENTITIES, uris.joinToString())
      uris.singleOrNull() != expectedUri ->
        rejected(AgentFailure.WRONG_IDENTITY, uris.singleOrNull() ?: "no identity")
      fingerprintOf(leaf) in revoked -> rejected(AgentFailure.REVOKED, fingerprintOf(leaf))
      else -> AgentCheckResult.Accepted(fingerprintOf(leaf))
    }
  }

  private fun rejected(failure: AgentFailure, detail: String) =
    AgentCheckResult.Rejected(failure, detail)

  private fun allowsServerAuth(leaf: X509Certificate): Boolean =
    try {
      leaf.extendedKeyUsage?.contains(SERVER_AUTH_OID) == true
    } catch (_: CertificateParsingException) {
      false
    }

  private fun uriNames(leaf: X509Certificate): List<String>? =
    try {
      leaf.subjectAlternativeNames.orEmpty().filter {
        it[0] == URI_NAME_TYPE
      }.map { it[1] as String }
    } catch (_: CertificateParsingException) {
      null
    }

  // A problem description, or null when the chain leads to the bundle and every date is valid.
  private fun chainProblem(chain: List<X509Certificate>): String? =
    when {
      anchors.isEmpty() -> "no CA certificates"
      chain.first().basicConstraints != -1 -> "the certificate is a CA"
      else -> validate(chain)
    }

  private fun validate(chain: List<X509Certificate>): String? =
    try {
      // A trust anchor is never part of the path it anchors.
      val path = chain.filter { candidate -> anchors.none { it == candidate } }
      val parameters =
        PKIXParameters(anchors.map { TrustAnchor(it, null) }.toSet()).apply {
          isRevocationEnabled = false
          date = Date(clock())
        }
      val factory = CertificateFactory.getInstance("X.509")
      CertPathValidator.getInstance("PKIX").validate(factory.generateCertPath(path), parameters)
      null
    } catch (error: GeneralSecurityException) {
      error.message ?: error.javaClass.simpleName
    }

  private companion object {
    fun parseBundle(pem: String): List<X509Certificate> =
      try {
        parseCertificates(pem)
      } catch (_: GeneralSecurityException) {
        emptyList()
      }
  }
}

/**
 * Accepts only what [AgentCheck] accepts, in place of the system trust store. [check] is asked on
 * each handshake, so a refreshed bundle or revocation list applies to the next connection.
 */
internal class AgentTrustManager(
  private val check: () -> AgentCheck?,
  /** Told the result of every check, so a caller can tell a refused agent from a network error. */
  private val observed: (AgentCheckResult) -> Unit = {}
) : X509TrustManager {
  override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) =
    throw CertificateException("This trust manager checks servers only.")

  override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {
    val result = verify(chain.orEmpty().toList())
    observed(result)
    if (result is AgentCheckResult.Rejected) throw AgentCheckException(result)
  }

  fun verify(chain: List<X509Certificate>): AgentCheckResult =
    check()?.check(chain) ?: AgentCheckResult.Rejected(AgentFailure.NO_TRUST, "no cached trust")

  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}
