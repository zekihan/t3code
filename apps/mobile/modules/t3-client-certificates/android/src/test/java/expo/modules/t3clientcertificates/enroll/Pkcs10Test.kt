package expo.modules.t3clientcertificates.enroll

import java.security.Signature
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class Pkcs10Test {
  private fun sign(key: java.security.PrivateKey): (ByteArray) -> ByteArray = { tbs ->
    Signature.getInstance("SHA256withECDSA").run {
      initSign(key)
      update(tbs)
      sign()
    }
  }

  @Test fun requestInfoIsByteForByteWhatTheHubsCodeBuilds() {
    val tbs = csrTbs(unhex(HubFixtures.SPKI_HEX), HubFixtures.IDENTITY)
    assertEquals(HubFixtures.CSR_TBS_HEX, hex(tbs))
  }

  @Test fun theHubsOwnRequestHasTheShapeThisCodeBuilds() {
    val theirs = decodeCsr(pemBody(HubFixtures.CSR_PEM))
    val keys = newKeyPair()
    val ours = decodeCsr(buildCsr(keys.public, HubFixtures.IDENTITY, sign(keys.private)))
    assertEquals(theirs.version, ours.version)
    assertEquals(theirs.signatureAlgorithm, ours.signatureAlgorithm)
    assertEquals(theirs.signatureParameters, ours.signatureParameters)
    assertEquals(theirs.uriSans, ours.uriSans)
    assertEquals(theirs.otherSans, ours.otherSans)
    assertEquals(theirs.extensionRequestCount, ours.extensionRequestCount)
    assertEquals(theirs.subject.raw.toList(), ours.subject.raw.toList())
    assertEquals(theirs.spki.size, ours.spki.size)
  }

  @Test fun decodedRequestCarriesOneUriAndNothingElse() {
    val keys = newKeyPair()
    val csr = decodeCsr(buildCsr(keys.public, "device-z-tablet-mesh", sign(keys.private)))
    assertEquals(0, csr.version)
    assertEquals("an empty subject", 0, csr.subject.content.size)
    assertEquals(listOf("urn:noqer:mtls:clients:device-z-tablet-mesh"), csr.uriSans)
    assertEquals("no DNS, IP or email names", 0, csr.otherSans)
    assertEquals("only the SAN extension", 1, csr.extensionRequestCount)
    assertEquals("ecdsa-with-SHA256", "1.2.840.10045.4.3.2", csr.signatureAlgorithm)
    assertFalse("no algorithm parameters", csr.signatureParameters)
  }

  @Test fun theRequestCarriesTheKeysP256PublicKeyAndItsSignatureVerifies() {
    val keys = newKeyPair()
    val csr = decodeCsr(buildCsr(keys.public, "device-z-phone-mesh", sign(keys.private)))
    assertArrayEquals(keys.public.encoded, csr.spki)
    val info = parseOne(csr.spki).children()
    assertEquals("ecPublicKey", "1.2.840.10045.2.1", oidString(info[0].children()[0].content))
    assertEquals("prime256v1", "1.2.840.10045.3.1.7", oidString(info[0].children()[1].content))
    assertEquals("an uncompressed point", 66, info[1].content.size)
    assertTrue(verifiesCsr(csr))
  }

  @Test fun aTamperedRequestFailsVerification() {
    val keys = newKeyPair()
    val csr = decodeCsr(buildCsr(keys.public, "device-z-phone-mesh", sign(keys.private)))
    val tampered =
      DecodedCsr(
        csr.version, csr.subject, csr.spki, csr.extensionRequestCount, csr.uriSans, csr.otherSans,
        csr.signatureAlgorithm, csr.signatureParameters,
        csr.tbs.copyOf().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() }, csr.signature
      )
    assertFalse(verifiesCsr(tampered))
  }

  @Test fun pemIsSixtyFourColumnsWithNewlines() {
    val keys = newKeyPair()
    val text = csrPem(buildCsr(keys.public, "device-z-phone-mesh", sign(keys.private)))
    val lines = text.trimEnd('\n').lines()
    assertEquals("-----BEGIN CERTIFICATE REQUEST-----", lines.first())
    assertEquals("-----END CERTIFICATE REQUEST-----", lines.last())
    assertTrue(lines.drop(1).dropLast(1).dropLast(1).all { it.length == 64 })
    assertTrue(text.endsWith("-----\n"))
    assertEquals(csr(text).uriSans, listOf("urn:noqer:mtls:clients:device-z-phone-mesh"))
  }

  private fun csr(pem: String) = decodeCsr(pemBody(pem))

  @Test fun onlyDeviceIdentitiesBuildARequest() {
    val keys = newKeyPair()
    for (bad in listOf(
      "agent-z-mac",
      "z-phone",
      "device-mesh",
      "device-z-phone",
      "Device-z-mesh",
      "device--mesh"
    )) {
      try {
        buildCsr(keys.public, bad, sign(keys.private))
        fail("accepted $bad")
      } catch (_: IllegalArgumentException) {
        // expected
      }
    }
  }

  @Test fun deviceIdentityNames() {
    val good =
      listOf("device-z-phone-mesh", "device-z-tablet-mesh", "device-a1-mesh", "device-a-b-c-mesh")
    good.forEach { assertTrue(it, isValidDeviceIdentity(it)) }
    val bad =
      listOf(
        "", "device-mesh", "device--mesh", "device-z-phone", "device-z-phone-mesh-", "agent-z-mac",
        "z-phone", "device-Z-mesh", "device-z_phone-mesh", "device-z phone-mesh",
        "device-z-phone-mesh\n",
        "device-z:phone-mesh", "device-" + "a".repeat(30) + "-mesh"
      )
    bad.forEach { assertFalse(it, isValidDeviceIdentity(it)) }
    // The hub issues for names of at most 40 characters.
    val longest = "device-" + "a".repeat(40 - "device--mesh".length) + "-mesh"
    assertEquals(40, longest.length)
    assertTrue(isValidDeviceIdentity(longest))
    assertFalse(isValidDeviceIdentity("device-a" + longest.drop(7)))
  }

  @Test fun derLengthsAndObjectIdentifiers() {
    assertEquals("30020500", hex(Der.tlv(0x30, byteArrayOf(5, 0))))
    assertEquals("0481c8", hex(Der.tlv(0x04, ByteArray(200)).copyOfRange(0, 3)))
    assertEquals("0482012c", hex(Der.tlv(0x04, ByteArray(300)).copyOfRange(0, 4)))
    assertEquals("06092a864886f70d01090e", hex(Der.oid("1.2.840.113549.1.9.14")))
    assertEquals("06082a8648ce3d040302", hex(Der.oid("1.2.840.10045.4.3.2")))
    assertEquals("0603551d11", hex(Der.oid("2.5.29.17")))
  }
}
