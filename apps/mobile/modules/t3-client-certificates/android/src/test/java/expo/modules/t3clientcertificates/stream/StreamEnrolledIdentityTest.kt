package expo.modules.t3clientcertificates.stream

import org.junit.Assert.assertEquals
import org.junit.Test

class StreamEnrolledIdentityTest {
  private val enrolled = StreamEnrolledIdentity("t3mesh-device-1", "PEM")

  @Test fun anEnrolledAliasIsAnsweredFromTheKeystoreOnly() {
    assertEquals(
      CredentialSource.Keystore(enrolled),
      credentialSource("enrolled:device-z-phone-mesh", enrolled)
    )
  }

  @Test fun anEnrolledAliasWithoutAKeystoreIdentityGetsNothingAndNeverKeyChain() {
    assertEquals(CredentialSource.None, credentialSource("enrolled:device-z-phone-mesh", null))
  }

  @Test fun aKeyChainAliasIsAnsweredFromKeyChain() {
    assertEquals(CredentialSource.KeyChain("phone"), credentialSource("phone", null))
    assertEquals(CredentialSource.KeyChain("phone"), credentialSource("phone", enrolled))
  }

  @Test fun theOriginRuleStillAppliesToAnEnrolledAlias() {
    val alias = "enrolled:device-z-phone-mesh"
    val proceed =
      decideClientCertificate(
        "https://t3.z-arch.mesh.noqer.com",
        alias,
        "t3.z-arch.mesh.noqer.com",
        443
      )
    assertEquals(ClientCertificateDecision.Proceed(alias), proceed)
    assertEquals(
      ClientCertificateDecision.Cancel,
      decideClientCertificate("https://t3.z-arch.mesh.noqer.com", alias, "evil.example", 443)
    )
    assertEquals(
      ClientCertificateDecision.Cancel,
      decideClientCertificate(
        "https://t3.z-arch.mesh.noqer.com",
        alias,
        "t3.z-arch.mesh.noqer.com",
        8443
      )
    )
  }
}
