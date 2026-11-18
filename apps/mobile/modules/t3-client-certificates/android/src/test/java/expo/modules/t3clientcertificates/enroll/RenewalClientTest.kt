package expo.modules.t3clientcertificates.enroll

import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class RenewalClientTest {
  private val server = MockWebServer().apply { start() }
  private val client = OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build()
  private fun renewal() = RenewalClient(client, server.url("/api/v1/renew").toString())

  @After fun stop() = runCatching { server.shutdown() }.let { }

  private fun failure(block: () -> Unit): EnrollmentException {
    try {
      block()
    } catch (error: EnrollmentException) {
      return error
    }
    fail("no failure")
    throw AssertionError()
  }

  @Test fun postsThePemRequestAsAnXPemFile() {
    server.enqueue(
      MockResponse().setBody(
        "{\"certificate\":\"CERT\",\"chain\":\"CHAIN\",\"caBundle\":\"BUNDLE\",\"caRevision\":\"r9\"}"
      )
    )
    val reply = renewal().renew(HubFixtures.CSR_PEM)
    assertEquals("CERT", reply.certificate)
    assertEquals("CHAIN", reply.chain)
    assertEquals("BUNDLE", reply.caBundle)
    assertEquals("r9", reply.caRevision)
    val request = server.takeRequest(2, TimeUnit.SECONDS)!!
    assertEquals("POST", request.method)
    assertEquals("/api/v1/renew", request.path)
    assertEquals("application/x-pem-file", request.getHeader("Content-Type"))
    assertEquals(HubFixtures.CSR_PEM, request.body.readUtf8())
  }

  @Test fun aReplyWithoutTheBundleIsFine() {
    server.enqueue(MockResponse().setBody("{\"certificate\":\"CERT\",\"chain\":\"CHAIN\"}"))
    val reply = renewal().renew("csr")
    assertEquals(null, reply.caBundle)
    assertEquals(null, reply.caRevision)
  }

  @Test fun theHubRefusingTheLeafMeansReEnrollment() {
    for (status in listOf(401, 403)) {
      server.enqueue(MockResponse().setResponseCode(status).setBody("superseded leaf"))
      assertEquals(EnrollCode.REENROLL_REQUIRED, failure { renewal().renew("csr") }.code)
    }
  }

  @Test fun otherClientErrorsCarryTheHubsText() {
    server.enqueue(
      MockResponse().setResponseCode(400).setBody("CSR key must differ from the current key\nmore")
    )
    val error = failure { renewal().renew("csr") }
    assertEquals(EnrollCode.CSR_REJECTED, error.code)
    assertTrue(error.message!!.contains("CSR key must differ"))
  }

  @Test fun tooManyRenewalsAndIssuanceFailuresHaveTheirOwnCodes() {
    server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "120"))
    assertEquals(EnrollCode.RATE_LIMITED, failure { renewal().renew("csr") }.code)
    server.enqueue(MockResponse().setResponseCode(502).setBody("issuance failed"))
    assertEquals(EnrollCode.ISSUANCE_FAILED, failure { renewal().renew("csr") }.code)
  }

  @Test fun serverErrorsAreHubErrors() {
    server.enqueue(MockResponse().setResponseCode(503).setBody("temporarily unavailable"))
    val error = failure { renewal().renew("csr") }
    assertEquals(EnrollCode.HUB_ERROR, error.code)
    assertTrue(error.message!!.contains("503"))
  }

  @Test fun anAnswerThatIsNotTheExpectedJsonIsABadReply() {
    server.enqueue(MockResponse().setBody("<html>"))
    assertEquals(EnrollCode.BAD_REPLY, failure { renewal().renew("csr") }.code)
    server.enqueue(MockResponse().setBody("{\"chain\":\"x\"}"))
    assertEquals(EnrollCode.BAD_REPLY, failure { renewal().renew("csr") }.code)
  }

  @Test fun aDeadConnectionIsANetworkProblem() {
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
    assertEquals(EnrollCode.NETWORK, failure { renewal().renew("csr") }.code)
  }

  @Test fun aHandshakeRefusedForTheClientCertificateMeansReEnrollment() {
    // A real server's refusal reaches a JVM client either as the TLS alert or, depending on
    // timing, as a broken pipe; feed the client the alert it must classify.
    val refused =
      OkHttpClient.Builder()
        .addInterceptor { throw SSLException("Received fatal alert: certificate_required") }
        .build()
    val error =
      failure { RenewalClient(refused, "https://hub.mesh.noqer.com/api/v1/renew").renew("csr") }
    assertEquals(EnrollCode.REENROLL_REQUIRED, error.code)
  }

  @Test fun aDroppedConnectionIsANetworkProblemNotARefusedLeaf() {
    val dropped =
      OkHttpClient.Builder()
        .addInterceptor { throw java.net.SocketException("Broken pipe") }
        .build()
    val error =
      failure { RenewalClient(dropped, "https://hub.mesh.noqer.com/api/v1/renew").renew("csr") }
    assertEquals(EnrollCode.NETWORK, error.code)
  }

  @Test fun aServerCertificateProblemIsNotMistakenForARefusedLeaf() {
    val ca = HeldCertificate.Builder().certificateAuthority(1).commonName("ca").build()
    val serverCert =
      HeldCertificate.Builder().commonName(
        "localhost"
      ).addSubjectAlternativeName("localhost").signedBy(ca).build()
    val serverTls = HandshakeCertificates.Builder().heldCertificate(
      serverCert,
      ca.certificate
    ).build()
    val secure =
      MockWebServer().apply {
        useHttps(serverTls.sslSocketFactory(), false)
        protocols = listOf(Protocol.HTTP_1_1)
        start()
      }
    // The client trusts nothing the server presents.
    val distrusting =
      OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build()
    try {
      val error =
        failure { RenewalClient(distrusting, secure.url("/api/v1/renew").toString()).renew("csr") }
      assertEquals(EnrollCode.TLS, error.code)
    } finally {
      secure.shutdown()
    }
  }

  @Test fun theRefusalCheckLooksAtTheAlertNotAtEveryTlsError() {
    assertTrue(
      clientCertificateRefused(
        javax.net.ssl.SSLHandshakeException("Received fatal alert: bad_certificate")
      )
    )
    assertTrue(clientCertificateRefused(javax.net.ssl.SSLException("TLSV1_ALERT_UNKNOWN_CA")))
    assertTrue(!clientCertificateRefused(javax.net.ssl.SSLException("Connection reset")))
    assertTrue(!clientCertificateRefused(IOException("Connection reset")))
    assertTrue(
      !clientCertificateRefused(javax.net.ssl.SSLPeerUnverifiedException("certificate unverified"))
    )
  }
}
