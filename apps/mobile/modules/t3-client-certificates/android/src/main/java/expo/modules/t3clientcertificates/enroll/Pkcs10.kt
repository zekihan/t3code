package expo.modules.t3clientcertificates.enroll

import java.io.ByteArrayOutputStream
import java.security.PublicKey
import okio.ByteString.Companion.toByteString

/** The URI SAN prefix of every identity the t3-mesh clients CA issues (`policy.URIPrefix`). */
internal const val IDENTITY_URI_PREFIX = "urn:noqer:mtls:clients:"

// `policy.MaxIdentityLen`: the longest name the hub issues a certificate for.
private const val MAX_IDENTITY_LENGTH = 40

// `device-<name>-mesh`: the enrolled-device kind, never an `agent-*` or a bare person's identity.
private val DEVICE_IDENTITY = Regex("^device-[a-z0-9]+(-[a-z0-9]+)*-mesh$")

internal fun isValidDeviceIdentity(name: String) =
  name.length <= MAX_IDENTITY_LENGTH && DEVICE_IDENTITY.matches(name)

internal fun identityUri(name: String) = IDENTITY_URI_PREFIX + name

/** The few DER encodings a PKCS#10 request needs. */
internal object Der {
  private const val SEQUENCE = 0x30
  private const val SET = 0x31
  private const val OCTET_STRING = 0x04
  private const val BIT_STRING = 0x03
  private const val OBJECT_IDENTIFIER = 0x06
  private const val CONTEXT_CONSTRUCTED = 0xA0
  private const val CONTEXT_PRIMITIVE = 0x80
  private const val SHORT_FORM_MAX = 0x7F
  private const val LONG_FORM = 0x80
  private const val BYTE_MASK = 0xFF
  private const val BASE_128 = 0x80
  private const val SEVEN_BITS = 0x7F
  private const val BITS_PER_BYTE = 8

  fun sequence(vararg parts: ByteArray) = tlv(SEQUENCE, concat(parts))

  fun set(vararg parts: ByteArray) = tlv(SET, concat(parts))

  fun integerZero() = byteArrayOf(0x02, 0x01, 0x00)

  fun octetString(content: ByteArray) = tlv(OCTET_STRING, content)

  /** A BIT STRING holding whole bytes. */
  fun bitString(content: ByteArray) = tlv(BIT_STRING, byteArrayOf(0) + content)

  fun contextConstructed(tag: Int, content: ByteArray) = tlv(CONTEXT_CONSTRUCTED or tag, content)

  fun contextPrimitive(tag: Int, content: ByteArray) = tlv(CONTEXT_PRIMITIVE or tag, content)

  fun oid(dotted: String): ByteArray {
    val arcs = dotted.split('.').map { it.toLong() }
    require(arcs.size >= 2) { "Object identifier needs two arcs" }
    val out = ByteArrayOutputStream()
    out.write((arcs[0] * 40 + arcs[1]).toInt())
    arcs.drop(2).forEach { arc ->
      val groups = mutableListOf(arc and SEVEN_BITS.toLong())
      var rest = arc shr 7
      while (rest > 0) {
        groups += (rest and SEVEN_BITS.toLong()) or BASE_128.toLong()
        rest = rest shr 7
      }
      groups.reversed().forEach { out.write(it.toInt()) }
    }
    return tlv(OBJECT_IDENTIFIER, out.toByteArray())
  }

  fun tlv(tag: Int, content: ByteArray): ByteArray {
    val out = ByteArrayOutputStream()
    out.write(tag)
    if (content.size <= SHORT_FORM_MAX) {
      out.write(content.size)
    } else {
      val length = lengthBytes(content.size)
      out.write(LONG_FORM or length.size)
      out.write(length)
    }
    out.write(content)
    return out.toByteArray()
  }

  private fun lengthBytes(size: Int): ByteArray {
    val bytes = mutableListOf<Byte>()
    var rest = size
    while (rest > 0) {
      bytes += (rest and BYTE_MASK).toByte()
      rest = rest shr BITS_PER_BYTE
    }
    return bytes.reversed().toByteArray()
  }

  private fun concat(parts: Array<out ByteArray>): ByteArray {
    val out = ByteArrayOutputStream()
    parts.forEach { out.write(it) }
    return out.toByteArray()
  }
}

private const val OID_EXTENSION_REQUEST = "1.2.840.113549.1.9.14"
private const val OID_SUBJECT_ALT_NAME = "2.5.29.17"
private const val OID_ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2"
private const val GENERAL_NAME_URI = 6

/** The certification request info: no subject, one URI SAN as the requested extension. */
internal fun csrTbs(subjectPublicKeyInfo: ByteArray, identity: String): ByteArray {
  val uri = Der.contextPrimitive(
    GENERAL_NAME_URI,
    identityUri(identity).toByteArray(Charsets.US_ASCII)
  )
  val subjectAltName =
    Der.sequence(Der.oid(OID_SUBJECT_ALT_NAME), Der.octetString(Der.sequence(uri)))
  val extensionRequest =
    Der.sequence(
      Der.oid(OID_EXTENSION_REQUEST),
      Der.set(Der.sequence(subjectAltName))
    )
  return Der.sequence(
    Der.integerZero(),
    Der.sequence(),
    subjectPublicKeyInfo,
    Der.contextConstructed(0, extensionRequest)
  )
}

/**
 * A DER PKCS#10 request for [publicKey], signed by [sign] with ecdsa-with-SHA256 over the
 * request info. [sign] returns a DER ECDSA-Sig-Value, which is what `SHA256withECDSA` produces.
 */
internal fun buildCsr(
  publicKey: PublicKey,
  identity: String,
  sign: (ByteArray) -> ByteArray
): ByteArray {
  require(isValidDeviceIdentity(identity)) { "Not a device identity: $identity" }
  val tbs = csrTbs(publicKey.encoded, identity)
  return Der.sequence(
    tbs,
    Der.sequence(Der.oid(OID_ECDSA_WITH_SHA256)),
    Der.bitString(sign(tbs))
  )
}

private const val PEM_LINE = 64

internal fun pem(label: String, der: ByteArray): String {
  val body = der.toByteString().base64().chunked(PEM_LINE).joinToString("\n")
  return "-----BEGIN $label-----\n$body\n-----END $label-----\n"
}

internal fun csrPem(der: ByteArray) = pem("CERTIFICATE REQUEST", der)
