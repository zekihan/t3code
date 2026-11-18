package expo.modules.t3clientcertificates.direct

import expo.modules.t3clientcertificates.enroll.EnrolledMaterial
import expo.modules.t3clientcertificates.enroll.TestCa
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.Executors
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class DirectProberTest {
  private val world = DirectWorld()
  private val scheduler = Executors.newScheduledThreadPool(2)
  private val closers = mutableListOf<() -> Unit>()
  private val deadlines = ProbeDeadlines(connectMs = 400, responseMs = 800)
  private lateinit var agent: MockWebServer
  private var current: EnrolledMaterial? = null
  private var previous: EnrolledMaterial? = null
  private val answer = """{"machine":"$MACHINE","identity":"device-z-phone-mesh"}"""

  @Before fun setUp() {
    current = world.device()
    agent = newAgent()
  }

  @After fun tearDown() {
    closers.forEach { runCatching { it() } }
    scheduler.shutdownNow()
  }

  private fun newAgent(
    leaf: AgentLeaf = world.agentLeaf(),
    admits: List<java.security.cert.X509Certificate> = listOf(world.clients.certificate)
  ) = agentServer(leaf, admits).also { closers += { it.shutdown() } }

  private fun prober(port: Int, trust: DirectTrust = world.trust()): DirectProber {
    val loopback = InetAddress.getByName("127.0.0.1")
    val proxy =
      DirectProxy(
        { host, p ->
          if (host == VIEWER &&
            p == 443
          ) {
            ProxyTarget(MACHINE, loopback, port)
          } else {
            null
          }
        },
        limits = ProxyLimits(connectTimeoutMs = 300, headerTimeoutMs = 500)
      ).also {
        it.start()
        closers += { it.stop() }
      }
    return DirectProber(
      proxy = { InetSocketAddress(loopback, proxy.port) },
      tls = DirectTls({ trust }),
      materials = { kind -> if (kind == IdentityKind.CURRENT) current else previous },
      scheduler = scheduler,
      deadlines = deadlines
    )
  }

  @Test fun aHealthyAgentAnswersTheProbeWithoutTouchingAnythingElse() {
    agent.enqueue(MockResponse().setBody(answer))
    val outcome = prober(agent.port).probe(world.route)
    val reached = outcome as ProbeOutcome.Reached
    assertEquals(IdentityKind.CURRENT, reached.identity)
    assertNotNull(reached.leafFingerprint)
    val request = agent.takeRequest()
    assertEquals("GET", request.method)
    assertEquals("/.well-known/t3-mesh/direct", request.path)
    assertEquals(VIEWER, request.getHeader("Host"))
    assertEquals(1, agent.requestCount)
  }

  @Test fun anAnswerThatIsNotTheAgentsOwnIsUnexpected() {
    listOf(
      """{"machine":"z-mac","identity":"device-z-phone-mesh"}""",
      """{"machine":"$MACHINE","identity":"device-z-tablet-mesh"}""",
      """{"machine":"$MACHINE","identity":"$AGENT_IDENTITY"}""",
      "<html>a viewer page</html>",
      ""
    ).forEach { body ->
      agent.enqueue(MockResponse().setBody(body))
      val outcome = prober(agent.port).probe(world.route) as ProbeOutcome.Failed
      assertEquals(body, FailureKind.UNEXPECTED, outcome.kind)
    }
    agent.enqueue(MockResponse().setResponseCode(404))
    assertEquals(
      FailureKind.UNEXPECTED,
      (prober(agent.port).probe(world.route) as ProbeOutcome.Failed).kind
    )
  }

  @Test fun anHttpAuthorizationRefusalIsAnAuthorizationFailure() {
    agent.enqueue(MockResponse().setResponseCode(403))
    val outcome = prober(agent.port).probe(world.route) as ProbeOutcome.Failed
    assertEquals(FailureKind.AUTHORIZATION, outcome.kind)
  }

  @Test fun anAgentOfAnotherIdentityOrCaIsACertificateFailure() {
    val impostors =
      listOf(
        world.agentLeaf(identity = "agent-z-mac"),
        world.agentLeaf(ca = TestCa("other CA")),
        world.agentLeaf(usages = listOf(expo.modules.t3clientcertificates.enroll.CLIENT_AUTH))
      )
    impostors.forEach { leaf ->
      val server = newAgent(leaf)
      val outcome = prober(server.port).probe(world.route) as ProbeOutcome.Failed
      assertEquals(FailureKind.CERTIFICATE, outcome.kind)
      assertEquals(0, server.requestCount)
    }
  }

  @Test fun aRevokedAgentLeafIsACertificateFailure() {
    val leaf = world.agentLeaf()
    val server = newAgent(leaf)
    val trust = world.trust(setOf(fingerprintOf(leaf.certificate)))
    val outcome = prober(server.port, trust).probe(world.route) as ProbeOutcome.Failed
    assertEquals(FailureKind.CERTIFICATE, outcome.kind)
  }

  @Test fun anAgentThatDoesNotAdmitTheDeviceIsAnAuthorizationFailure() {
    current = world.device(ca = TestCa("devices of someone else"))
    val outcome = prober(agent.port).probe(world.route) as ProbeOutcome.Failed
    assertEquals(FailureKind.AUTHORIZATION, outcome.kind)
  }

  @Test fun aNewLeafThatIsRefusedFallsBackToThePreviousIdentityForTheOverlap() {
    val oldCa = TestCa("old devices")
    val server = newAgent(admits = listOf(oldCa.certificate))
    current = world.device(ca = TestCa("new devices"))
    previous = world.device(ca = oldCa)
    server.enqueue(MockResponse().setBody(answer))
    val outcome = prober(server.port).probe(world.route)
    assertEquals(IdentityKind.PREVIOUS, (outcome as ProbeOutcome.Reached).identity)
    assertEquals(1, server.requestCount)
  }

  @Test fun whenThePreviousIdentityIsRefusedToo() {
    val server = newAgent(admits = listOf(TestCa("nobody").certificate))
    current = world.device(ca = TestCa("new devices"))
    previous = world.device(ca = TestCa("older devices"))
    val outcome = prober(server.port).probe(world.route) as ProbeOutcome.Failed
    assertEquals(FailureKind.AUTHORIZATION, outcome.kind)
  }

  @Test fun noPreviousIdentityMeansNoSecondAttempt() {
    current = world.device(ca = TestCa("new devices"))
    previous = null
    val outcome = prober(agent.port).probe(world.route) as ProbeOutcome.Failed
    assertEquals(FailureKind.AUTHORIZATION, outcome.kind)
  }

  @Test fun theCurrentIdentityIsNotRetriedForAFailureThatIsNotAnAuthorizationOne() {
    previous = world.device()
    agent.shutdown()
    val outcome = prober(agent.port).probe(world.route) as ProbeOutcome.Failed
    assertEquals(FailureKind.UNREACHABLE, outcome.kind)
  }

  @Test fun aStalledHandshakeFallsBackWithinTheTcpAndTlsDeadline() {
    val silent = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
    closers += { silent.close() }
    val accepted = mutableListOf<java.net.Socket>()
    Thread { while (!silent.isClosed) runCatching { accepted += silent.accept() } }.apply {
      isDaemon =
        true
    }.start()
    val started = System.nanoTime()
    val outcome = prober(silent.localPort).probe(world.route) as ProbeOutcome.Failed
    val elapsedMs = (System.nanoTime() - started) / 1_000_000
    assertEquals(FailureKind.TIMEOUT, outcome.kind)
    assertTrue(outcome.detail, outcome.detail.contains("TCP and TLS"))
    assertTrue("took $elapsedMs ms", elapsedMs < deadlines.connectMs + 600)
    accepted.forEach { runCatching { it.close() } }
  }

  @Test fun aPeerThatCompletesTlsButNeverAnswersFallsBackWithinTheResponseDeadline() {
    agent.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
    val started = System.nanoTime()
    val outcome = prober(agent.port).probe(world.route) as ProbeOutcome.Failed
    val elapsedMs = (System.nanoTime() - started) / 1_000_000
    assertEquals(FailureKind.TIMEOUT, outcome.kind)
    assertTrue(outcome.detail, outcome.detail.contains("did not answer"))
    assertTrue("took $elapsedMs ms", elapsedMs >= deadlines.responseMs - 100)
    assertTrue("took $elapsedMs ms", elapsedMs < deadlines.connectMs + deadlines.responseMs + 600)
  }

  @Test fun anUnreachableAgentFailsFast() {
    val port = agent.port
    agent.shutdown()
    val started = System.nanoTime()
    val outcome = prober(port).probe(world.route) as ProbeOutcome.Failed
    assertEquals(FailureKind.UNREACHABLE, outcome.kind)
    assertTrue((System.nanoTime() - started) / 1_000_000 < deadlines.connectMs)
  }

  @Test fun withoutTheLocalProxyThereIsNothingToProbe() {
    val prober =
      DirectProber({ null }, DirectTls({ world.trust() }), { current }, scheduler, deadlines)
    assertEquals(FailureKind.UNREACHABLE, (prober.probe(world.route) as ProbeOutcome.Failed).kind)
  }

  @Test fun onlyATlsAlertAboutTheCertificateIsAnAuthorizationFailureOnALiveConnection() {
    val accepted = AgentCheckResult.Accepted("fp")
    val alert = javax.net.ssl.SSLHandshakeException("Received fatal alert: certificate_required")
    val boringAlert =
      javax.net.ssl.SSLProtocolException(
        "ssl=0x1: Failure in SSL library: SSLV3_ALERT_BAD_CERTIFICATE"
      )
    val reset =
      javax.net.ssl.SSLProtocolException(
        "Read error: ssl=0x1: I/O error during system call, Connection reset by peer"
      )
    assertEquals(FailureKind.AUTHORIZATION, classifyFailure(alert, accepted, null).first)
    assertEquals(FailureKind.AUTHORIZATION, classifyFailure(boringAlert, accepted, null).first)
    assertEquals(FailureKind.UNREACHABLE, classifyFailure(reset, accepted, null).first)
    assertEquals(
      FailureKind.UNREACHABLE,
      classifyFailure(java.net.SocketException("reset"), accepted, null).first
    )
    // A fresh connection that is reset right after the handshake is a refusal that lost its alert.
    assertEquals(
      FailureKind.AUTHORIZATION,
      classifyFailure(
        java.net.SocketException("reset"),
        accepted,
        null,
        freshConnection = true
      ).first
    )
    assertEquals(FailureKind.UNREACHABLE, classifyFailure(alert, null, null).first)
    assertEquals(FailureKind.TIMEOUT, classifyFailure(alert, accepted, "slow").first)
  }

  @Test fun theDeadlinesAreTwoSecondsForTcpAndTlsAndFiveForTheAnswer() {
    val defaults = ProbeDeadlines()
    assertEquals(2_000L, defaults.connectMs)
    assertEquals(5_000L, defaults.responseMs)
  }
}
