package expo.modules.t3clientcertificates.enroll

import java.io.ByteArrayInputStream
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.text.SimpleDateFormat
import java.util.Date
import java.util.TimeZone
import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.decodeHex

internal fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

internal fun unhex(text: String) = text.decodeHex().toByteArray()

internal const val DAY = 24L * 60 * 60 * 1000

/** 2026-11-18T12:00:00Z, inside every certificate the tests issue unless a test says otherwise. */
internal const val NOW = 1_795_003_200_000L

// ---- an independent DER reader, so the tests do not trust the encoder they check ----

internal class Tlv(val tag: Int, val content: ByteArray, val raw: ByteArray) {
  fun children(): List<Tlv> = parseTlvs(content)
}

internal fun parseTlvs(bytes: ByteArray): List<Tlv> {
  val out = mutableListOf<Tlv>()
  var at = 0
  while (at < bytes.size) {
    val start = at
    val tag = bytes[at++].toInt() and 0xFF
    var length = bytes[at++].toInt() and 0xFF
    if (length >= 0x80) {
      val count = length and 0x7F
      length = 0
      repeat(count) { length = (length shl 8) or (bytes[at++].toInt() and 0xFF) }
    }
    out += Tlv(tag, bytes.copyOfRange(at, at + length), bytes.copyOfRange(start, at + length))
    at += length
  }
  return out
}

internal fun parseOne(bytes: ByteArray): Tlv = parseTlvs(bytes).single()

internal fun oidString(content: ByteArray): String {
  val parts = mutableListOf((content[0].toInt() and 0xFF) / 40, (content[0].toInt() and 0xFF) % 40)
  var value = 0L
  for (i in 1 until content.size) {
    val b = content[i].toInt() and 0xFF
    value = (value shl 7) or (b and 0x7F).toLong()
    if (b and 0x80 == 0) {
      parts += value.toInt()
      value = 0
    }
  }
  return parts.joinToString(".")
}

@Suppress("LongParameterList") // A flat decoded structure.
internal class DecodedCsr(
  val version: Int,
  val subject: Tlv,
  val spki: ByteArray,
  val extensionRequestCount: Int,
  val uriSans: List<String>,
  val otherSans: Int,
  val signatureAlgorithm: String,
  val signatureParameters: Boolean,
  val tbs: ByteArray,
  val signature: ByteArray
)

internal fun pemBody(pem: String): ByteArray =
  pem.lines().filter {
    it.isNotBlank() && !it.startsWith("-----")
  }.joinToString("").decodeBase64()!!.toByteArray()

internal fun decodeCsr(der: ByteArray): DecodedCsr {
  val request = parseOne(der).children()
  val info = request[0].children()
  val signatureAlgorithm = request[1].children()
  val bits = request[2]
  require(bits.tag == 0x03 && bits.content[0].toInt() == 0) {
    "signature must be a whole-byte BIT STRING"
  }
  val attributes = info[3]
  require(attributes.tag == 0xA0) { "attributes must be [0]" }
  val attribute = attributes.children().single().children()
  require(oidString(attribute[0].content) == "1.2.840.113549.1.9.14") { "extensionRequest" }
  val extensions = parseOne(attribute[1].children().single().raw).children()
  val sanExtensions = extensions.map { it.children() }.filter {
    oidString(it[0].content) ==
      "2.5.29.17"
  }
  val names = parseOne(sanExtensions.single().last().children().single().raw).children()
  return DecodedCsr(
    version = info[0].content[0].toInt(),
    subject = info[1],
    spki = info[2].raw,
    extensionRequestCount = extensions.size,
    uriSans = names.filter { it.tag == 0x86 }.map { String(it.content, Charsets.US_ASCII) },
    otherSans = names.count { it.tag != 0x86 },
    signatureAlgorithm = oidString(signatureAlgorithm[0].content),
    signatureParameters = signatureAlgorithm.size > 1,
    tbs = request[0].raw,
    signature = bits.content.copyOfRange(1, bits.content.size)
  )
}

internal fun publicKeyOf(spki: ByteArray): PublicKey =
  KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki))

internal fun verifiesCsr(csr: DecodedCsr): Boolean =
  Signature.getInstance("SHA256withECDSA").run {
    initVerify(publicKeyOf(csr.spki))
    update(csr.tbs)
    verify(csr.signature)
  }

// ---- a certificate authority that builds X.509 certificates with the Der writer ----

internal class TestCa(private val name: String = "test clients CA") {
  val keyPair: KeyPair = newKeyPair()
  private var serial = 100L
  private val subject =
    Der.sequence(Der.set(Der.sequence(Der.oid("2.5.4.3"), Der.tlv(0x0C, name.toByteArray()))))

  val certificate: X509Certificate =
    sign(
      issuer = subject,
      subject = subject,
      key = keyPair.public,
      notBefore = NOW - 365 * DAY,
      notAfter = NOW + 3650 * DAY,
      extensions =
        listOf(
          extension("2.5.29.19", true, Der.sequence(byteArrayOf(0x01, 0x01, 0xFF.toByte()))),
          extension("2.5.29.15", true, Der.tlv(0x03, byteArrayOf(0x01, 0x06)))
        )
    )

  val certificatePem: String = pem("CERTIFICATE", certificate.encoded)

  /** A device certificate: empty subject, the URIs (and any DNS names) as a critical SAN, client auth. */
  fun issue(
    publicKey: PublicKey,
    uris: List<String>,
    dns: List<String> = emptyList(),
    notBefore: Long = NOW - DAY,
    notAfter: Long = NOW + 365 * DAY
  ): X509Certificate {
    val names =
      uris.map { Der.contextPrimitive(6, it.toByteArray()) } +
        dns.map { Der.contextPrimitive(2, it.toByteArray()) }
    return sign(
      issuer = subject,
      subject = Der.sequence(),
      key = publicKey,
      notBefore = notBefore,
      notAfter = notAfter,
      extensions =
        listOf(
          extension("2.5.29.17", true, Der.sequence(*names.toTypedArray())),
          extension("2.5.29.37", false, Der.sequence(Der.oid("1.3.6.1.5.5.7.3.2")))
        )
    )
  }

  private fun extension(oid: String, critical: Boolean, value: ByteArray) =
    if (critical) {
      Der.sequence(Der.oid(oid), byteArrayOf(0x01, 0x01, 0xFF.toByte()), Der.octetString(value))
    } else {
      Der.sequence(Der.oid(oid), Der.octetString(value))
    }

  @Suppress("LongParameterList")
  private fun sign(
    issuer: ByteArray,
    subject: ByteArray,
    key: PublicKey,
    notBefore: Long,
    notAfter: Long,
    extensions: List<ByteArray>
  ): X509Certificate {
    val algorithm = Der.sequence(Der.oid("1.2.840.10045.4.3.2"))
    val tbs =
      Der.sequence(
        Der.contextConstructed(0, byteArrayOf(0x02, 0x01, 0x02)),
        Der.tlv(0x02, BigInteger.valueOf(serial++).toByteArray()),
        algorithm,
        issuer,
        Der.sequence(utcTime(notBefore), utcTime(notAfter)),
        subject,
        key.encoded,
        Der.contextConstructed(3, Der.sequence(*extensions.toTypedArray()))
      )
    val signature =
      Signature.getInstance("SHA256withECDSA").run {
        initSign(keyPair.private)
        update(tbs)
        sign()
      }
    val der = Der.sequence(tbs, algorithm, Der.bitString(signature))
    return CertificateFactory.getInstance(
      "X.509"
    ).generateCertificate(ByteArrayInputStream(der)) as X509Certificate
  }

  private fun utcTime(epochMs: Long): ByteArray {
    val format = SimpleDateFormat("yyMMddHHmmss'Z'").apply {
      timeZone = TimeZone.getTimeZone("UTC")
    }
    return Der.tlv(0x17, format.format(Date(epochMs)).toByteArray())
  }
}

internal fun newKeyPair(): KeyPair =
  KeyPairGenerator.getInstance("EC").apply {
    initialize(ECGenParameterSpec("secp256r1"))
  }.generateKeyPair()

// ---- doubles for the Keystore and the preferences ----

internal class SoftwareKeyBackend : KeyBackend {
  val pairs = LinkedHashMap<String, KeyPair>()
  val deleted = mutableListOf<String>()
  val foreign = mutableListOf<String>()
  var failGenerate: RuntimeException? = null
  var protection = KeyProtection.TEE

  override fun generate(alias: String): PublicKey {
    failGenerate?.let { throw it }
    check(alias !in pairs) { "alias reused: $alias" }
    return newKeyPair().also { pairs[alias] = it }.public
  }

  override fun privateKey(alias: String): PrivateKey? = pairs[alias]?.private

  override fun delete(alias: String) {
    pairs.remove(alias)
    foreign.remove(alias)
    deleted += alias
  }

  override fun aliases() = pairs.keys.toList() + foreign

  override fun protection(alias: String) = protection

  override fun exportable(alias: String) = false
}

internal class MemoryStorage : EnrollmentStorage {
  var state: EnrollmentState? = null
  var origins: Set<String> = emptySet()
  var saves = 0

  override fun load() = state

  override fun save(state: EnrollmentState?) {
    this.state = state
    saves++
  }

  override fun meshOrigins() = origins

  override fun saveMeshOrigins(origins: Set<String>) {
    this.origins = origins
  }
}

/**
 * A hub in miniature for the manager tests. It checks the CSR as the real hub does (signature,
 * one URI SAN, empty subject, P-256), issues from [ca], and binds a token to one identity.
 */
internal class FakeHub(
  val ca: TestCa,
  private val clock: () -> Long
) : EnrollExchange, RenewExchange {
  val tokens = mutableMapOf<String, String>()
  val csrs = mutableListOf<DecodedCsr>()
  val issued = mutableListOf<X509Certificate>()
  var enrollFailure: EnrollmentException? = null
  var renewFailure: EnrollmentException? = null
  var certificateLifetime = 365 * DAY
  var caBundle: String? = ca.certificatePem
  var caRevision: String? = "rev-1"
  var tamper: ((X509Certificate, PublicKey) -> X509Certificate)? = null
  var beforeReply: () -> Unit = {}

  override fun exchange(token: String, csrPem: String): EnrollWire.Reply.Enrolled {
    enrollFailure?.let { throw it }
    val csr = accept(csrPem)
    val identity = csr.uriSans.single().removePrefix(IDENTITY_URI_PREFIX)
    if (tokens.remove(token) != identity) throw rejectException("enroll-failed", "invalid token")
    return reply(csr).let { EnrollWire.Reply.Enrolled(it.first, it.second, caBundle, caRevision) }
  }

  override fun renew(csrPem: String): RenewReply {
    renewFailure?.let { throw it }
    val csr = accept(csrPem)
    return reply(csr).let { RenewReply(it.first, it.second, caBundle, caRevision) }
  }

  private fun accept(csrPem: String): DecodedCsr {
    val csr = decodeCsr(pemBody(csrPem))
    csrs += csr
    check(verifiesCsr(csr)) { "CSR signature" }
    check(
      csr.version == 0 && csr.subject.content.isEmpty() && csr.otherSans == 0 &&
        csr.uriSans.size == 1
    )
    return csr
  }

  private fun reply(csr: DecodedCsr): Pair<String, String> {
    beforeReply()
    val key = publicKeyOf(csr.spki)
    var leaf = ca.issue(
      key,
      csr.uriSans,
      notBefore = clock() - DAY,
      notAfter =
        clock() + certificateLifetime
    )
    issued += leaf
    tamper?.let { leaf = it(leaf, key) }
    return pem("CERTIFICATE", leaf.encoded) to ca.certificatePem
  }
}
