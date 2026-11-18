package expo.modules.t3clientcertificates.enroll

import expo.modules.t3clientcertificates.MESH_HUB_ORIGIN
import expo.modules.t3clientcertificates.OriginSocketFactory
import expo.modules.t3clientcertificates.SelectedIdentity
import expo.modules.t3clientcertificates.certificateOrigin
import expo.modules.t3clientcertificates.originHostnameVerifier
import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class IdentitySelectionTest {
  // ---- which origins are mesh origins ----

  @Test fun theHubAndListedViewerHostsAreMeshOrigins() {
    val listed = setOf("https://t3.z-arch.mesh.noqer.com/")
    assertTrue(isMeshOrigin(MESH_HUB_ORIGIN, emptySet()) { false })
    assertTrue(isMeshOrigin("https://t3.z-arch.mesh.noqer.com/", listed) { false })
    assertTrue(
      "an origin the Mesh screen assigned an alias to earlier",
      isMeshOrigin("https://t3.z-mac.mesh.noqer.com/", listed) {
        it ==
          "https://t3.z-mac.mesh.noqer.com/"
      }
    )
  }

  @Test fun unlistedAndForeignHostsAreNotMeshOrigins() {
    val listed = setOf("https://t3.z-arch.mesh.noqer.com/")
    val others =
      listOf(
        "https://t3.devbox.mesh.noqer.com/",
        "https://mesh.noqer.com/",
        "https://t3.z-arch.mesh.noqer.com:8443/",
        "https://evil.example/",
        "https://t3.z-arch.mesh.noqer.com.evil.example/",
        "https://hub.mesh.noqer.com:8443/",
        "https://localhost:8443/"
      )
    others.forEach { assertFalse(it, isMeshOrigin(it, listed) { false }) }
  }

  @Test fun aMarkerOnAForeignOriginDoesNotMakeItAMeshOrigin() {
    assertFalse(isMeshOrigin("https://evil.example/", emptySet()) { true })
    assertFalse(isMeshOrigin("https://t3.a.mesh.noqer.com.evil.example/", emptySet()) { true })
  }

  @Test fun theListFromTheHubIsFilteredToExactViewerOrigins() {
    val clean =
      sanitizeMeshOrigins(
        listOf(
          "https://t3.z-arch.mesh.noqer.com",
          "https://t3.z-arch.mesh.noqer.com/",
          "https://t3.z-mac.mesh.noqer.com/path?x=1",
          "https://evil.example/",
          "http://t3.a.mesh.noqer.com/",
          "https://t3.a.mesh.noqer.com:444/",
          "https://user@t3.a.mesh.noqer.com/",
          "https://hub.mesh.noqer.com/",
          "not a url"
        )
      )
    assertEquals(
      setOf("https://t3.z-arch.mesh.noqer.com/", "https://t3.z-mac.mesh.noqer.com/"),
      clean
    )
  }

  @Test fun enrolledAliasesAreRecognized() {
    assertEquals("enrolled:device-z-phone-mesh", enrolledAlias("device-z-phone-mesh"))
    assertTrue(isEnrolledAlias("enrolled:device-z-phone-mesh"))
    assertFalse(isEnrolledAlias("my-keychain-alias"))
    assertFalse(isEnrolledAlias(null))
  }

  // ---- the choice ----

  @Test fun anEnrolledMeshOriginNeverReadsTheKeyChainAlias() {
    val choice =
      chooseIdentity(enrolled = true, meshOrigin = true) {
        fail("KeyChain alias was read")
        null
      }
    assertEquals(IdentityChoice.Enrolled, choice)
  }

  @Test fun otherOriginsKeepTheirKeyChainChoice() {
    assertEquals(
      IdentityChoice.KeyChain("phone"),
      chooseIdentity(enrolled = true, meshOrigin = false) { "phone" }
    )
    assertEquals(
      IdentityChoice.Anonymous,
      chooseIdentity(enrolled = true, meshOrigin = false) {
        null
      }
    )
  }

  @Test fun beforeEnrollmentMeshOriginsUseKeyChainAsBefore() {
    assertEquals(
      IdentityChoice.KeyChain("phone"),
      chooseIdentity(enrolled = false, meshOrigin = true) { "phone" }
    )
    assertEquals(
      IdentityChoice.Anonymous,
      chooseIdentity(enrolled = false, meshOrigin = true) {
        null
      }
    )
  }

  private class Loaders {
    val calls = mutableListOf<String>()
    var enrolledFails = false
  }

  private fun identities(loaders: Loaders, enrolled: Boolean, mesh: Set<String>) =
    OriginIdentities(
      enrolled = { enrolled },
      meshOrigin = { it in mesh },
      keyChainAlias = { if (it.contains("keychain")) "kc" else null },
      fromEnrolled = {
        loaders.calls += "enrolled"
        if (loaders.enrolledFails) throw IOException("unavailable") else "E"
      },
      fromKeyChain = { _, alias ->
        loaders.calls += "keychain:$alias"
        "K"
      },
      anonymous = {
        loaders.calls += "anonymous"
        "A"
      }
    )

  @Test fun theFactoryNeverCallsKeyChainForAnEnrolledMeshOrigin() {
    val loaders = Loaders()
    val factory = identities(loaders, enrolled = true, mesh = setOf("https://keychain-mesh/"))
    assertEquals("E", factory.factory("https://keychain-mesh/"))
    assertEquals(listOf("enrolled"), loaders.calls)
  }

  @Test fun anUnusableEnrolledIdentityFailsInsteadOfFallingBack() {
    val loaders = Loaders().apply { enrolledFails = true }
    val factory = identities(loaders, enrolled = true, mesh = setOf("https://keychain-mesh/"))
    try {
      factory.factory("https://keychain-mesh/")
      fail("fell back")
    } catch (_: IOException) {
      // expected
    }
    assertEquals(listOf("enrolled"), loaders.calls)
  }

  @Test fun nonMeshOriginsAreUnaffectedByTheEnrollment() {
    val loaders = Loaders()
    val factory = identities(loaders, enrolled = true, mesh = setOf("https://hub/"))
    assertEquals("K", factory.factory("https://keychain-other/"))
    assertEquals("A", factory.factory("https://plain/"))
    assertEquals(listOf("keychain:kc", "anonymous"), loaders.calls)
  }

  // ---- on the wire: what a TLS server actually sees ----

  private val ca = HeldCertificate.Builder().certificateAuthority(1).commonName("test CA").build()
  private val serverCertificate =
    HeldCertificate.Builder()
      .commonName("localhost")
      .addSubjectAlternativeName("localhost")
      .addSubjectAlternativeName("t3.test")
      .signedBy(ca)
      .build()
  private val enrolledCertificate = HeldCertificate.Builder().commonName(
    "enrolled device"
  ).signedBy(ca).build()
  private val keyChainCertificate = HeldCertificate.Builder().commonName(
    "keychain phone"
  ).signedBy(ca).build()
  private val serverTls =
    HandshakeCertificates.Builder()
      .heldCertificate(serverCertificate, ca.certificate)
      .addTrustedCertificate(ca.certificate)
      .build()
  private val clientTrust = HandshakeCertificates.Builder().addTrustedCertificate(
    ca.certificate
  ).build()

  private fun contextFor(identity: HeldCertificate, alias: String): SSLContext =
    SSLContext.getInstance("TLS").apply {
      val selected =
        SelectedIdentity(
          alias,
          identity.keyPair.private,
          arrayOf(identity.certificate, ca.certificate)
        )
      init(arrayOf(selected), arrayOf(clientTrust.trustManager), null)
    }

  @Test fun serverSeesTheEnrolledCertificateOnMeshOriginsAndKeyChainOnesElsewhere() {
    val server =
      MockWebServer().apply {
        useHttps(serverTls.sslSocketFactory(), false)
        requestClientAuth()
        protocols = listOf(Protocol.HTTP_1_1)
        start()
      }
    val dns =
      object : Dns {
        override fun lookup(hostname: String): List<InetAddress> =
          if (hostname ==
            "t3.test"
          ) {
            listOf(InetAddress.getByName("127.0.0.1"))
          } else {
            Dns.SYSTEM.lookup(hostname)
          }
      }
    val meshOrigin = certificateOrigin(server.url("/").toString())!!
    val keyChainReads = mutableListOf<String>()
    val identities =
      OriginIdentities<SSLSocketFactory>(
        enrolled = { true },
        meshOrigin = { it == meshOrigin },
        keyChainAlias = { origin ->
          keyChainReads += origin
          "phone"
        },
        fromEnrolled = { contextFor(enrolledCertificate, "keystore").socketFactory },
        fromKeyChain = { _, alias -> contextFor(keyChainCertificate, alias).socketFactory },
        anonymous = { clientTrust.sslSocketFactory() }
      )
    val client =
      OkHttpClient.Builder()
        .dns(dns)
        .sslSocketFactory(
          OriginSocketFactory(clientTrust.sslSocketFactory(), identities::factory, { _, _ -> }),
          clientTrust.trustManager
        )
        .hostnameVerifier(originHostnameVerifier)
        .callTimeout(5, TimeUnit.SECONDS)
        .build()
    try {
      server.enqueue(MockResponse().setBody("mesh"))
      client.newCall(Request.Builder().url(server.url("/")).build()).execute().use {
        assertEquals(200, it.code)
      }
      assertEquals(
        enrolledCertificate.certificate,
        server.takeRequest(2, TimeUnit.SECONDS)!!.handshake!!.peerCertificates.first()
      )
      assertTrue("KeyChain was not consulted for the mesh origin", keyChainReads.isEmpty())

      server.enqueue(MockResponse().setBody("other"))
      val other = server.url("/").newBuilder().host("t3.test").build()
      client.newCall(Request.Builder().url(other).build()).execute().use {
        assertEquals(200, it.code)
      }
      assertEquals(
        keyChainCertificate.certificate,
        server.takeRequest(2, TimeUnit.SECONDS)!!.handshake!!.peerCertificates.first()
      )
      assertEquals(listOf("https://t3.test:${server.port}/"), keyChainReads)
    } finally {
      client.connectionPool.evictAll()
      server.shutdown()
    }
  }

  @Test fun nothingIsPresentedWhenTheEnrolledIdentityCannotBeUsed() {
    val server =
      MockWebServer().apply {
        useHttps(serverTls.sslSocketFactory(), false)
        requestClientAuth()
        protocols = listOf(Protocol.HTTP_1_1)
        start()
      }
    val meshOrigin = certificateOrigin(server.url("/").toString())!!
    val identities =
      OriginIdentities<SSLSocketFactory>(
        enrolled = { true },
        meshOrigin = { it == meshOrigin },
        keyChainAlias = {
          fail("KeyChain was consulted")
          null
        },
        fromEnrolled = {
          throw IOException(
            "The enrolled device identity is missing. Re-enroll this device in Mesh."
          )
        },
        fromKeyChain = { _, _ ->
          fail("KeyChain was used")
          clientTrust.sslSocketFactory()
        },
        anonymous = { clientTrust.sslSocketFactory() }
      )
    val client =
      OkHttpClient.Builder()
        .sslSocketFactory(
          OriginSocketFactory(clientTrust.sslSocketFactory(), identities::factory, { _, _ -> }),
          clientTrust.trustManager
        )
        .hostnameVerifier(originHostnameVerifier)
        .callTimeout(5, TimeUnit.SECONDS)
        .build()
    try {
      try {
        client.newCall(Request.Builder().url(server.url("/")).build()).execute().close()
        fail("connected without the enrolled identity")
      } catch (error: IOException) {
        // OkHttp may try another route for localhost and report that failure first.
        val messages =
          generateSequence<Throwable>(error) { it.cause }
            .flatMap { sequenceOf(it) + it.suppressed.asSequence() }
            .mapNotNull { it.message }
            .toList()
        assertTrue(messages.toString(), messages.any { "Re-enroll" in it })
      }
      assertEquals("the server never got a request", 0, server.requestCount)
      assertNull(null)
    } finally {
      server.shutdown()
    }
  }
}
