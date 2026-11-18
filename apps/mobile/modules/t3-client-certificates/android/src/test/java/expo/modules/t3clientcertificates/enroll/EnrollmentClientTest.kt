package expo.modules.t3clientcertificates.enroll

import java.io.DataInputStream
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.ExtendedSSLSession
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The enrollment client against a TLS server in the test, standing in for the hub's `mesh.noqer.com`. */
class EnrollmentClientTest {
  private val ca = HeldCertificate.Builder().certificateAuthority(1).commonName("web CA").build()
  private val servers = mutableListOf<FakeEnrollServer>()

  private fun trust(): SSLSocketFactory =
    HandshakeCertificates.Builder().addTrustedCertificate(ca.certificate).build().sslSocketFactory()

  private fun serverCertificates(
    host: String,
    signer: HeldCertificate = ca
  ): HandshakeCertificates {
    val held =
      HeldCertificate.Builder().commonName(
        host
      ).addSubjectAlternativeName(host).signedBy(signer).build()
    return HandshakeCertificates.Builder().heldCertificate(held, signer.certificate).build()
  }

  private class Seen(
    val applicationProtocol: String,
    val serverNames: List<String>,
    val clientCertificate: Boolean,
    val request: ByteArray
  )

  private inner class FakeEnrollServer(
    certificates: HandshakeCertificates,
    private val offerAlpn: Boolean = true,
    private val needClientAuth: Boolean = false,
    private val reply: (ByteArray) -> ByteArray? = { unhex(HubFixtures.ENROLLED_FRAME_HEX) },
    private val stall: Boolean = false
  ) {
    val seen = CopyOnWriteArrayList<Seen>()
    private val release = CountDownLatch(1)
    private val socket =
      certificates.sslContext().serverSocketFactory.createServerSocket(
        0,
        5,
        InetAddress.getByName("127.0.0.1")
      )
        as SSLServerSocket
    val port get() = socket.localPort

    init {
      servers += this
      Thread {
        try {
          while (!socket.isClosed) serve(socket.accept() as SSLSocket)
        } catch (_: Exception) {
          // closed
        }
      }.apply { isDaemon = true }.start()
    }

    private fun serve(client: SSLSocket) {
      try {
        val parameters = client.sslParameters
        if (offerAlpn) parameters.applicationProtocols = arrayOf(EnrollWire.ALPN)
        if (needClientAuth) parameters.needClientAuth = true else parameters.wantClientAuth = true
        client.sslParameters = parameters
        client.startHandshake()
        val session = client.session as ExtendedSSLSession
        val names = session.requestedServerNames.filterIsInstance<SNIHostName>().map {
          it.asciiName
        }
        val hasCertificate =
          try {
            session.peerCertificates.isNotEmpty()
          } catch (_: SSLPeerUnverifiedException) {
            false
          }
        val input = DataInputStream(client.inputStream)
        val size = input.readInt()
        val body = ByteArray(size).also { input.readFully(it) }
        seen += Seen(client.applicationProtocol, names, hasCertificate, body)
        if (stall) release.await(10, TimeUnit.SECONDS)
        reply(body)?.let {
          client.outputStream.write(it)
          client.outputStream.flush()
        }
      } catch (_: Exception) {
        // the client may hang up or the handshake may be refused on purpose
      } finally {
        runCatching { client.close() }
      }
    }

    fun close() {
      release.countDown()
      runCatching { socket.close() }
    }
  }

  @After fun stopServers() = servers.forEach { it.close() }

  private fun client(
    server: FakeEnrollServer,
    tls: SSLSocketFactory = trust(),
    timeout: Int = 5_000
  ) =
    EnrollmentClient(
      host = "mesh.noqer.com",
      port = server.port,
      dial = "127.0.0.1",
      tls = tls,
      timeouts = EnrollTimeouts(exchangeMs = timeout)
    )

  private fun failure(block: () -> Unit): EnrollmentException {
    try {
      block()
    } catch (error: EnrollmentException) {
      return error
    }
    fail("no failure")
    throw AssertionError()
  }

  @Test fun enrollsOverTheEnrollmentAlpnWithoutAClientCertificate() {
    val server = FakeEnrollServer(serverCertificates("mesh.noqer.com"))
    val reply = client(server).exchange(HubFixtures.ENROLL_TOKEN, HubFixtures.CSR_PEM)
    assertEquals(EnrollWire.Reply.Enrolled("LEAF\n", "CHAIN\n", null, null), reply)
    val seen = server.seen.single()
    assertEquals("t3-mesh-enroll/1", seen.applicationProtocol)
    assertEquals(listOf("mesh.noqer.com"), seen.serverNames)
    assertFalse("no client certificate is offered", seen.clientCertificate)
    assertArrayEquals(
      unhex(HubFixtures.ENROLL_FRAME_HEX).copyOfRange(4, unhex(HubFixtures.ENROLL_FRAME_HEX).size),
      seen.request
    )
  }

  @Test fun aRejectionBecomesItsCode() {
    val server =
      FakeEnrollServer(serverCertificates("mesh.noqer.com"), reply = {
        unhex(HubFixtures.REJECT_FRAME_HEX)
      })
    val error = failure { client(server).exchange("used", HubFixtures.CSR_PEM) }
    assertEquals(EnrollCode.TOKEN_INVALID, error.code)
    assertTrue(error.message!!.contains("15 minutes"))
  }

  @Test fun theHubsCertificateMustCarryTheEnrollmentHostName() {
    val server = FakeEnrollServer(serverCertificates("hub.mesh.noqer.com"))
    assertEquals(EnrollCode.TLS, failure { client(server).exchange("t", HubFixtures.CSR_PEM) }.code)
    assertTrue("nothing was sent to the wrong host", server.seen.isEmpty())
  }

  @Test fun theHubsCertificateMustChainToATrustedRoot() {
    val other = HeldCertificate.Builder().certificateAuthority(1).commonName("other CA").build()
    val server = FakeEnrollServer(serverCertificates("mesh.noqer.com", other))
    assertEquals(EnrollCode.TLS, failure { client(server).exchange("t", HubFixtures.CSR_PEM) }.code)
    assertTrue(server.seen.isEmpty())
  }

  @Test fun aServerThatDoesNotOfferTheEnrollmentAlpnIsRefused() {
    val server = FakeEnrollServer(serverCertificates("mesh.noqer.com"), offerAlpn = false)
    val error = failure { client(server).exchange("t", HubFixtures.CSR_PEM) }
    assertEquals(EnrollCode.HUB_ERROR, error.code)
    assertTrue("the token was not sent", server.seen.isEmpty())
  }

  @Test fun aHubWithNoOpenTokenHangsUpTheHandshake() {
    // The hub completes the enrollment ALPN only while a token is outstanding; the test server
    // stands in by demanding a client certificate this client never offers.
    val server = FakeEnrollServer(serverCertificates("mesh.noqer.com"), needClientAuth = true)
    val error = failure { client(server).exchange("t", HubFixtures.CSR_PEM) }
    assertEquals(EnrollCode.NO_ENROLLMENT_OPEN, error.code)
    assertTrue(error.message!!.contains("token"))
  }

  @Test fun aRefusedConnectionIsANetworkProblem() {
    val server = FakeEnrollServer(serverCertificates("mesh.noqer.com"))
    val port = server.port
    server.close()
    val client =
      EnrollmentClient(
        "mesh.noqer.com",
        port,
        "127.0.0.1",
        trust(),
        timeouts = EnrollTimeouts(exchangeMs = 2_000)
      )
    assertEquals(EnrollCode.NETWORK, failure { client.exchange("t", HubFixtures.CSR_PEM) }.code)
  }

  @Test fun aHubThatNeverAnswersTimesOut() {
    val server = FakeEnrollServer(serverCertificates("mesh.noqer.com"), stall = true)
    val started = System.nanoTime()
    val error = failure { client(server, timeout = 500).exchange("t", HubFixtures.CSR_PEM) }
    assertEquals(EnrollCode.NETWORK, error.code)
    assertTrue("gave up within the deadline", (System.nanoTime() - started) < 5_000_000_000L)
  }

  @Test fun aHubThatHangsUpWithoutAnswerIsANetworkProblem() {
    val server = FakeEnrollServer(serverCertificates("mesh.noqer.com"), reply = { null })
    assertEquals(
      EnrollCode.NETWORK,
      failure {
        client(server).exchange("t", HubFixtures.CSR_PEM)
      }.code
    )
  }

  @Test fun anUnexpectedAnswerIsAHubError() {
    val pong = "{\"type\":\"Pong\",\"body\":{}}".toByteArray()
    val frame = byteArrayOf(0, 0, 0, pong.size.toByte()) + pong
    val server = FakeEnrollServer(serverCertificates("mesh.noqer.com"), reply = { frame })
    assertEquals(
      EnrollCode.HUB_ERROR,
      failure {
        client(server).exchange("t", HubFixtures.CSR_PEM)
      }.code
    )
  }

  @Test fun theRequestSizeLimitIsEnforcedBeforeConnecting() {
    val server = FakeEnrollServer(serverCertificates("mesh.noqer.com"))
    val error = failure { client(server).exchange("t", "x".repeat(EnrollWire.MAX_REQUEST_BYTES)) }
    assertEquals(EnrollCode.CSR_REJECTED, error.code)
    assertTrue(server.seen.isEmpty())
  }

  @Test fun failuresAreClassifiedByWhereTheyHappened() {
    val timeout = java.net.SocketTimeoutException("slow")
    assertEquals(EnrollCode.NETWORK, classifyTransportFailure(EnrollPhase.HANDSHAKE, timeout).code)
    val unverified = SSLPeerUnverifiedException("no")
    assertEquals(EnrollCode.TLS, classifyTransportFailure(EnrollPhase.HANDSHAKE, unverified).code)
    val wrapped = javax.net.ssl.SSLHandshakeException("x").apply {
      initCause(java.security.cert.CertificateException("y"))
    }
    assertEquals(EnrollCode.TLS, classifyTransportFailure(EnrollPhase.EXCHANGE, wrapped).code)
    val alert = javax.net.ssl.SSLException("Received fatal alert: bad_certificate")
    assertEquals(
      EnrollCode.NO_ENROLLMENT_OPEN,
      classifyTransportFailure(EnrollPhase.EXCHANGE, alert).code
    )
    assertEquals(EnrollCode.NETWORK, classifyTransportFailure(EnrollPhase.CONNECT, alert).code)
    assertEquals(
      EnrollCode.NETWORK,
      classifyTransportFailure(EnrollPhase.CONNECT, java.io.IOException("down")).code
    )
  }
}
