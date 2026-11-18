package expo.modules.t3clientcertificates.enroll

import java.io.ByteArrayInputStream
import java.security.PublicKey
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Date

private const val GENERAL_NAME_URI_TYPE = 6

/** A certificate the hub issued for this device, checked and ready to present. */
internal class IssuedCertificate(
  val leaf: X509Certificate,
  /** The leaf first, then the hub's chain without a duplicate of the leaf. */
  val chain: List<X509Certificate>,
  val chainPem: String,
  val caBundlePem: String?,
  val caRevision: String?
)

internal fun parseCertificates(pem: String): List<X509Certificate> {
  if (pem.isBlank()) return emptyList()
  val factory = CertificateFactory.getInstance("X.509")
  return factory
    .generateCertificates(ByteArrayInputStream(pem.toByteArray(Charsets.US_ASCII)))
    .map { it as X509Certificate }
}

internal fun chainToPem(certificates: List<X509Certificate>) =
  certificates.joinToString("") { pem("CERTIFICATE", it.encoded) }

/** The URI SANs of a certificate, and whether it carries any other kind of name. */
internal fun uriSans(certificate: X509Certificate): Pair<List<String>, Boolean> {
  val names = certificate.subjectAlternativeNames.orEmpty()
  val uris = names.filter { it[0] == GENERAL_NAME_URI_TYPE }.map { it[1] as String }
  return uris to (names.size != uris.size)
}

/** The hub's answer to an enrollment or a renewal: the same four fields. */
internal data class IssuedReply(
  val certificate: String,
  val chain: String,
  val caBundle: String?,
  val caRevision: String?
)

/**
 * Accepts the hub's answer only when it is a usable certificate for [identity] and [publicKey]: one
 * URI SAN equal to the identity's URI and no other names, the key we generated, and not expired.
 * Anything else means the hub (or something in the way) did not issue what was asked for.
 */
@Suppress("ThrowsCount") // Each rejected shape has its own message.
internal fun acceptIssued(
  reply: IssuedReply,
  identity: String,
  publicKey: PublicKey,
  now: Long
): IssuedCertificate {
  try {
    val leaves = parseCertificates(reply.certificate)
    if (leaves.size != 1) throw enrollmentError(EnrollCode.BAD_REPLY, "expected one certificate")
    val leaf = leaves.single()
    val (uris, otherNames) = uriSans(leaf)
    if (uris != listOf(identityUri(identity)) || otherNames) {
      throw enrollmentError(EnrollCode.BAD_REPLY, "the certificate names a different identity")
    }
    if (!leaf.publicKey.encoded.contentEquals(publicKey.encoded)) {
      throw enrollmentError(EnrollCode.BAD_REPLY, "the certificate is for a different key")
    }
    if (!leaf.notAfter.after(Date(now))) {
      throw enrollmentError(EnrollCode.BAD_REPLY, "the certificate has already expired")
    }
    val extra = parseCertificates(reply.chain).filter { it != leaf }
    val bundle = reply.caBundle?.let(::parseCertificates)
    if (reply.caBundle != null && bundle.isNullOrEmpty()) {
      throw enrollmentError(EnrollCode.BAD_REPLY, "the CA bundle is empty")
    }
    val chain = listOf(leaf) + extra
    return IssuedCertificate(leaf, chain, chainToPem(chain), reply.caBundle, reply.caRevision)
  } catch (error: CertificateException) {
    throw enrollmentError(EnrollCode.BAD_REPLY, "unreadable certificate", error)
  }
}
