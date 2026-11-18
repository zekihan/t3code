package expo.modules.t3clientcertificates.direct

import expo.modules.t3clientcertificates.OriginSocketFactory
import expo.modules.t3clientcertificates.enroll.EnrolledMaterial
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

private class FakeRouter : DirectRouter {
  @Volatile var path = ActivePath(direct = true, identity = IdentityKind.CURRENT)
  var relay: DirectProxy? = null
  var pool: ConnectionPool? = null
  val failures = mutableListOf<Pair<FailureKind, String>>()
  val unknown = mutableListOf<String>()

  @Volatile var lastAgentResult: AgentCheckResult? = null
  var evictions = 0

  override fun awaitPath(machine: String) = path

  override fun relayAddress(): InetSocketAddress? =
    relay?.port?.takeIf {
      it != 0
    }?.let { InetSocketAddress(InetAddress.getByName("127.0.0.1"), it) }

  override fun directFailed(machine: String, error: IOException) {
    println(
      "DIRECT FAILED: " +
        generateSequence<Throwable>(error) { it.cause }.joinToString(" <- ") {
          it.javaClass.simpleName +
            ":" +
            it.message
        } +
        " agent=" +
        lastAgentResult
    )
    failures += classifyFailure(error, lastAgentResult, null)
    path = ActivePath.VIEWER
  }

  override fun unknownOutcome(machine: String, method: String) {
    unknown += method
  }

  override fun evictIdleConnections() {
    evictions++
    pool?.evictAll()
  }
}

class DirectRoutingTest {
  private val world = DirectWorld()
  private val viewerFixture = ViewerFixture()
  private val servers = mutableListOf<MockWebServer>()
  private val proxies = mutableListOf<DirectProxy>()
  private lateinit var viewer: MockWebServer
  private lateinit var agent: MockWebServer
  private lateinit var router: FakeRouter
  private lateinit var device: EnrolledMaterial

  @Before fun setUp() {
    viewer = viewerFixture.server().also { servers += it }
    agent = newAgent()
    router = FakeRouter()
    device = world.device()
    router.relay = relayTo(agent)
  }

  @After fun tearDown() {
    proxies.forEach { it.stop() }
    servers.forEach { runCatching { it.shutdown() } }
  }

  private fun newAgent(
    leaf: AgentLeaf = world.agentLeaf()
  ) =
    agentServer(leaf, listOf(world.clients.certificate)).also { servers += it }

  private fun relayTo(server: MockWebServer): DirectProxy =
    DirectProxy({ host, port ->
      if (host == VIEWER &&
        port == 443
      ) {
        ProxyTarget(MACHINE, InetAddress.getByName("127.0.0.1"), server.port)
      } else {
        null
      }
    }, limits = ProxyLimits(connectTimeoutMs = 500, headerTimeoutMs = 500)).also {
      it.start()
      proxies += it
    }

  private fun client(
    material: EnrolledMaterial = device,
    readTimeoutMs: Long = 600,
    trust: DirectTrust = world.trust()
  ): OkHttpClient {
    val tls = DirectTls({ trust })
    val pins = PathPins()
    val pool = ConnectionPool()
    router.pool = pool
    val route = world.route
    val sockets =
      OriginSocketFactory(
        viewerFixture.clientTls.sslSocketFactory(),
        { viewerFixture.clientTls.sslSocketFactory() },
        { _, _ -> },
        direct = { _, raw: Socket ->
          if (router.relay?.isProxyEndpoint(raw.inetAddress, raw.port) == true) {
            tls.socketFactory(
              route,
              material,
              tls.trustManager(route) {
                router.lastAgentResult = it
              }
            )
          } else {
            null
          }
        }
      )
    return OkHttpClient.Builder()
      .viewerAt(viewer.port)
      .sslSocketFactory(sockets, viewerFixture.clientTls.trustManager)
      .hostnameVerifier(
        DirectHostnameVerifier(OkHttpClient().hostnameVerifier) {
          tls.checkFor(route)
        }
      )
      .connectionPool(pool)
      .proxySelector(DirectProxySelector(router, pins) { null })
      .addInterceptor(DirectRoutingInterceptor(router, pins))
      .addNetworkInterceptor(DirectPathGuard())
      .readTimeout(readTimeoutMs, TimeUnit.MILLISECONDS)
      .connectTimeout(1, TimeUnit.SECONDS)
      .retryOnConnectionFailure(false)
      .build()
  }

  private fun url(path: String = "/api/ping") = "https://$VIEWER$path"

  private fun get(client: OkHttpClient, method: String = "GET"): Response =
    client.newCall(Request.Builder().url(url()).method(method, null).build()).execute()

  private fun post(client: OkHttpClient, method: String = "POST"): Response =
    client.newCall(
      Request.Builder().url(url()).method(method, "body".toRequestBody()).build()
    ).execute()

  @Test fun aDirectRequestKeepsTheViewerHostAndPresentsTheDeviceIdentity() {
    agent.enqueue(MockResponse().setBody("direct"))
    val client = client()
    get(client).use { assertEquals("direct", it.body!!.string()) }
    val recorded = agent.takeRequest(2, TimeUnit.SECONDS)!!
    assertEquals(VIEWER, recorded.getHeader("Host"))
    assertEquals("/api/ping", recorded.path)
    val peer = recorded.handshake!!.peerCertificates.first() as java.security.cert.X509Certificate
    assertEquals(
      listOf("urn:noqer:mtls:clients:device-z-phone-mesh"),
      peer.subjectAlternativeNames.map { it[1] }
    )
    assertEquals(0, viewer.requestCount)
    assertTrue(router.failures.isEmpty())
  }

  @Test fun theViewerPathNeverTouchesTheAgent() {
    router.path = ActivePath.VIEWER
    viewer.enqueue(MockResponse().setBody("viewer"))
    get(client()).use { assertEquals("viewer", it.body!!.string()) }
    assertEquals(0, agent.requestCount)
    assertEquals(0, router.relay!!.openTunnels)
  }

  @Test fun otherHostsNeverGoThroughTheProxy() {
    val plain = MockWebServer().also { servers += it }.apply { start() }
    plain.enqueue(MockResponse().setBody("plain"))
    client().newCall(Request.Builder().url(plain.url("/")).build()).execute().use {
      assertEquals("plain", it.body!!.string())
    }
    assertEquals(0, agent.requestCount)
    assertEquals(0, router.relay!!.openTunnels)
  }

  @Test fun anUnreachableAgentFallsBackToTheViewerHostForAGetAndAPost() {
    agent.shutdown()
    viewer.enqueue(MockResponse().setBody("get via viewer"))
    viewer.enqueue(MockResponse().setBody("post via viewer"))
    val client = client()
    get(client).use { assertEquals("get via viewer", it.body!!.string()) }
    assertEquals(FailureKind.UNREACHABLE, router.failures.single().first)
    // A POST that failed before it was sent on the direct path is sent once, on the viewer host.
    router.path = ActivePath(direct = true, identity = IdentityKind.CURRENT)
    post(client).use { assertEquals("post via viewer", it.body!!.string()) }
    assertEquals(
      listOf("GET", "POST"),
      listOf(viewer.takeRequest().method, viewer.takeRequest().method)
    )
    assertTrue(router.unknown.isEmpty())
  }

  @Test fun aPostWhoseResponseIsWithheldIsNotRepeatedOnTheViewerHost() {
    listOf("POST", "PUT", "PATCH", "DELETE").forEach { method ->
      router.path = ActivePath(direct = true, identity = IdentityKind.CURRENT)
      agent.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
      viewer.enqueue(MockResponse().setBody("must not be used"))
      try {
        post(client(), method).close()
        fail("$method must not succeed")
      } catch (error: UnknownOutcomeException) {
        assertEquals(method, error.method)
      }
      assertEquals(method, agent.takeRequest(2, TimeUnit.SECONDS)!!.method)
    }
    assertEquals(0, viewer.requestCount)
    assertEquals(listOf("POST", "PUT", "PATCH", "DELETE"), router.unknown)
  }

  @Test fun aPostThatLosesItsConnectionAfterItWasSentIsNotRepeatedOnAnyPath() {
    listOf("POST", "PUT", "DELETE").forEach { method ->
      router.path = ActivePath(direct = true, identity = IdentityKind.CURRENT)
      // The agent reads the request and the connection dies before any answer.
      agent.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
      agent.enqueue(MockResponse().setBody("a repeated $method would get this"))
      viewer.enqueue(MockResponse().setBody("must not be used"))
      try {
        post(client(), method).close()
        fail("$method must not succeed")
      } catch (error: UnknownOutcomeException) {
        assertEquals(method, error.method)
      }
      assertEquals(method, agent.takeRequest(2, TimeUnit.SECONDS)!!.method)
      assertEquals("one execution", 1, agent.requestCount)
      agent.shutdown()
      agent = newAgent()
      router.relay = relayTo(agent)
      viewer.shutdown()
      viewer = viewerFixture.server().also { servers += it }
    }
    assertEquals(listOf("POST", "PUT", "DELETE"), router.unknown)
  }

  @Test fun aGetThatLosesItsConnectionIsRepeatedAndGoesToTheViewerHostWhenTheAgentStaysDown() {
    agent.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
    viewer.enqueue(MockResponse().setBody("viewer"))
    agent.shutdown()
    get(client()).use { assertEquals("viewer", it.body!!.string()) }
    assertTrue(router.unknown.isEmpty())
  }

  @Test fun aGetOrHeadWhoseResponseIsWithheldIsRepeatedOnTheViewerHost() {
    listOf("GET", "HEAD").forEach { method ->
      router.path = ActivePath(direct = true, identity = IdentityKind.CURRENT)
      agent.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
      viewer.enqueue(MockResponse().setBody(if (method == "GET") "again" else ""))
      get(client(), method).use { assertEquals(200, it.code) }
    }
    assertEquals(2, viewer.requestCount)
    assertTrue(router.unknown.isEmpty())
  }

  @Test fun aWebSocketOpenIsRepeatedOnTheViewerHost() {
    agent.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
    viewer.enqueue(
      MockResponse().withWebSocketUpgrade(
        object : WebSocketListener() {}
      )
    )
    val opened = CountDownLatch(1)
    val socket =
      client().newWebSocket(
        Request.Builder().url("wss://$VIEWER/ws").build(),
        object : WebSocketListener() {
          override fun onOpen(webSocket: WebSocket, response: Response) = opened.countDown()
        }
      )
    assertTrue(opened.await(5, TimeUnit.SECONDS))
    socket.close(1000, null)
    assertEquals(1, viewer.requestCount)
  }

  @Test fun aWrongAgentIdentityIsACertificateFailureAndTheViewerHostIsUsed() {
    agent.shutdown()
    agent = newAgent(world.agentLeaf(identity = "agent-z-mac"))
    router.relay = relayTo(agent)
    viewer.enqueue(MockResponse().setBody("viewer"))
    get(client()).use { assertEquals("viewer", it.body!!.string()) }
    assertEquals(FailureKind.CERTIFICATE, router.failures.single().first)
    assertEquals(0, agent.requestCount)
  }

  @Test fun anAgentFromAnotherCaIsACertificateFailure() {
    agent.shutdown()
    agent =
      newAgent(world.agentLeaf(ca = expo.modules.t3clientcertificates.enroll.TestCa("other CA")))
    router.relay = relayTo(agent)
    viewer.enqueue(MockResponse().setBody("viewer"))
    get(client()).use { assertEquals("viewer", it.body!!.string()) }
    assertEquals(FailureKind.CERTIFICATE, router.failures.single().first)
  }

  @Test fun aRevokedAgentLeafIsACertificateFailure() {
    val leaf = world.agentLeaf()
    agent.shutdown()
    agent = newAgent(leaf)
    router.relay = relayTo(agent)
    viewer.enqueue(MockResponse().setBody("viewer"))
    get(client(trust = world.trust(setOf(fingerprintOf(leaf.certificate))))).use {
      assertEquals("viewer", it.body!!.string())
    }
    assertEquals(FailureKind.CERTIFICATE, router.failures.single().first)
  }

  @Test fun anAgentThatRefusesTheDeviceIsAnAuthorizationFailure() {
    val stranger = expo.modules.t3clientcertificates.enroll.TestCa("devices of someone else")
    viewer.enqueue(MockResponse().setBody("viewer"))
    get(client(material = world.device(ca = stranger))).use {
      assertEquals("viewer", it.body!!.string())
    }
    assertEquals(FailureKind.AUTHORIZATION, router.failures.single().first)
    assertEquals(0, agent.requestCount)
  }

  @Test fun aPooledDirectConnectionIsNotReusedByAViewerRequest() {
    val client = client()
    agent.enqueue(MockResponse().setBody("direct"))
    get(client).use { assertEquals("direct", it.body!!.string()) }
    assertEquals(1, client.connectionPool.connectionCount())
    router.path = ActivePath.VIEWER
    viewer.enqueue(MockResponse().setBody("viewer"))
    get(client).use { assertEquals("viewer", it.body!!.string()) }
    assertEquals(1, viewer.requestCount)
    assertEquals(1, agent.requestCount)
    assertTrue(router.evictions >= 1)
  }

  @Test fun aPooledViewerConnectionIsNotReusedByADirectRequest() {
    val client = client()
    router.path = ActivePath.VIEWER
    viewer.enqueue(MockResponse().setBody("viewer"))
    get(client).use { assertEquals("viewer", it.body!!.string()) }
    router.path = ActivePath(direct = true, identity = IdentityKind.CURRENT)
    agent.enqueue(MockResponse().setBody("direct"))
    get(client).use { assertEquals("direct", it.body!!.string()) }
    assertEquals(1, agent.requestCount)
    assertEquals(1, viewer.requestCount)
  }

  @Test fun aMissingProxyMeansTheViewerHostNotAFailure() {
    router.relay!!.stop()
    viewer.enqueue(MockResponse().setBody("viewer"))
    get(client()).use { assertEquals("viewer", it.body!!.string()) }
    assertTrue(router.failures.isEmpty())
    assertEquals(0, agent.requestCount)
  }

  @Test fun onlyGetAndHeadAreReplaySafe() {
    assertTrue(replaySafe("GET"))
    assertTrue(replaySafe("HEAD"))
    listOf("POST", "PUT", "PATCH", "DELETE", "OPTIONS", "get", "CONNECT").forEach {
      assertFalse(it, replaySafe(it))
    }
  }

  @Test fun theHostNameVerifierAcceptsOnlyTheAgentCheckInPlaceOfAHostName() {
    val trust = world.trust()
    val tls = DirectTls({ trust })
    val check = tls.checkFor(world.route)
    assertNotNull(check)
    assertNull(DirectTls({ null }).checkFor(world.route))
    assertTrue(tls.checkFor(world.route) === check)
  }
}
