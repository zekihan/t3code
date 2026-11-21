package expo.modules.t3clientcertificates.direct

import expo.modules.t3clientcertificates.enroll.EnrolledMaterial
import expo.modules.t3clientcertificates.localnet.LocalNetworkState
import expo.modules.t3clientcertificates.stream.StreamEnrolledIdentity
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

private class MemoryDirectStore(var snapshot: DirectSnapshot = DirectSnapshot(null, emptyMap())) :
  DirectStore {
  override fun load() = snapshot

  override fun save(snapshot: DirectSnapshot) {
    this.snapshot = snapshot
  }
}

class DirectPathsTest {
  private val world = DirectWorld()
  private val loopback = InetAddress.getByName("127.0.0.1")
  private val worker = Executors.newScheduledThreadPool(4)
  private val closers = mutableListOf<() -> Unit>()
  private var now = System.currentTimeMillis()
  private val device = world.device()
  private val answer = """{"machine":"$MACHINE","identity":"device-z-phone-mesh"}"""
  private val deadlines = ProbeDeadlines(connectMs = 400, responseMs = 800)
  private val fleetCalls = AtomicInteger()
  private val trustCalls = AtomicInteger()
  private val changes = CopyOnWriteArrayList<PathChange>()
  private var home: HubGate? = HubGate.HOME
  private var hubDetail = "hub down"
  private var slowHubMs = 0L
  private var fleetHook: (Int) -> Unit = {}
  private var agentPort = 0
  private var lan = LocalNetworkState.NOT_REQUIRED
  private lateinit var agent: MockWebServer

  @Before fun setUp() {
    agent = agentServer(world.agentLeaf(), listOf(world.clients.certificate)).also {
      closers += { it.shutdown() }
    }
    agentPort = agent.port
  }

  @After fun tearDown() {
    closers.forEach { runCatching { it() } }
    worker.shutdownNow()
  }

  private fun route() = DirectRoute(MACHINE, "192.168.2.41", agentPort, AGENT_IDENTITY, now)

  private fun paths(
    store: DirectStore = MemoryDirectStore(),
    maxWaitMs: Long = 5_000,
    hubWaitMs: Long = 1_500
  ): DirectPaths =
    DirectPaths(
      store = store,
      clock = { now },
      identities =
        object : DirectIdentities {
          override fun material(kind: IdentityKind): EnrolledMaterial? =
            if (kind == IdentityKind.CURRENT) device else null

          override fun stream(kind: IdentityKind) = StreamEnrolledIdentity("alias", "chain")
        },
      hubFleet = {
        fleetHook(fleetCalls.incrementAndGet())
        if (slowHubMs > 0) Thread.sleep(slowHubMs)
        home?.let { HubReply.Ok(FleetAnswer(it, mapOf(MACHINE to route()))) }
          ?: HubReply.Failed(hubDetail)
      },
      hubTrust = {
        trustCalls.incrementAndGet()
        if (home ==
          null
        ) {
          HubReply.Failed(hubDetail)
        } else {
          HubReply.Ok(world.trust().copy(fetchedAt = now))
        }
      },
      worker = worker,
      timings =
        DirectTimings(
          maxWaitMs = maxWaitMs,
          idleStopMs = 200,
          hubDebounceMs = 0,
          hubWaitMs = hubWaitMs,
          recheckMs = 25
        ),
      deadlines = deadlines,
      limits = ProxyLimits(connectTimeoutMs = 300, headerTimeoutMs = 500),
      addressOf = { loopback },
      localNetwork = { lan },
      onChange = { changes += it }
    ).also {
      closers += { it.shutdown() }
      it.setEnrolled(true)
      awaitFirstHubContact(it, store)
    }

  // With nothing cached the first request goes to the viewer host; the tests start after the hub
  // has been heard from, as an app that has run before would be.
  private fun awaitFirstHubContact(paths: DirectPaths, store: DirectStore) {
    if (store.load().trust != null || home == null) return
    val deadline = System.nanoTime() + 3_000_000_000L
    while (paths.status(MACHINE).trustFetchedAt == null && System.nanoTime() < deadline) {
      Thread.sleep(10)
    }
  }

  private fun stored(): MemoryDirectStore =
    MemoryDirectStore(
      DirectSnapshot(world.trust().copy(fetchedAt = now), mapOf(MACHINE to route()))
    )

  private fun viewer(reason: ViewerReason) = ActivePath(false, reason = reason)

  private val directNow = ActivePath(true, IdentityKind.CURRENT)

  private fun awaitUntil(timeoutMs: Long = 3_000, check: () -> Boolean) {
    val deadline = System.nanoTime() + timeoutMs * 1_000_000
    while (!check() && System.nanoTime() < deadline) Thread.sleep(10)
    assertTrue("not reached within $timeoutMs ms", check())
  }

  @Test fun atHomeWithAHealthyAgentTheProbePassesAndThePathIsDirect() {
    agent.enqueue(MockResponse().setBody(answer))
    val paths = paths()
    val path = paths.awaitPath(MACHINE)
    assertEquals(ActivePath(true, IdentityKind.CURRENT), path)
    assertTrue(paths.status(MACHINE).direct)
    assertEquals("/.well-known/t3-mesh/direct", agent.takeRequest().path)
    assertNotNull(paths.relayAddress())
    assertEquals(1, fleetCalls.get())
    assertEquals(1, trustCalls.get())
  }

  @Test fun awayFromHomeMakesNoDirectAttemptAtAll() {
    home = HubGate.AWAY
    val paths = paths()
    assertEquals(viewer(ViewerReason.AWAY), paths.awaitPath(MACHINE))
    assertEquals(0, agent.requestCount)
    assertNull(paths.relayAddress())
  }

  @Test fun withoutTheLocalNetworkPermissionNoProbeRunsAndTheViewerHostIsUsed() {
    lan = LocalNetworkState.DENIED
    val paths = paths(stored())
    assertEquals(viewer(ViewerReason.LOCAL_NETWORK_DENIED), paths.awaitPath(MACHINE))
    assertEquals(ViewerReason.LOCAL_NETWORK_DENIED, paths.status(MACHINE).reason)
    Thread.sleep(150)
    assertEquals(0, agent.requestCount)
    assertNull(paths.relayAddress())
  }

  @Test fun aGrantBringsTheHubContactAndTheProbeBackAtOnce() {
    lan = LocalNetworkState.DENIED
    agent.enqueue(MockResponse().setBody(answer))
    val paths = paths(stored())
    assertEquals(viewer(ViewerReason.LOCAL_NETWORK_DENIED), paths.awaitPath(MACHINE))
    val hubBefore = fleetCalls.get()
    lan = LocalNetworkState.GRANTED
    paths.refreshLocalNetwork()
    assertEquals(ActivePath(true, IdentityKind.CURRENT), paths.awaitPath(MACHINE))
    assertTrue(fleetCalls.get() > hubBefore)
    assertEquals(1, agent.requestCount)
  }

  @Test fun takingThePermissionAwayEndsTheDirectPath() {
    agent.enqueue(MockResponse().setBody(answer))
    val paths = paths()
    assertEquals(ActivePath(true, IdentityKind.CURRENT), paths.awaitPath(MACHINE))
    lan = LocalNetworkState.DENIED
    paths.refreshLocalNetwork()
    assertEquals(viewer(ViewerReason.LOCAL_NETWORK_DENIED), paths.awaitPath(MACHINE))
    assertFalse(paths.status(MACHINE).direct)
  }

  @Test fun theFirstRequestWithNothingCachedDoesNotWaitForTheHub() {
    val paths =
      DirectPaths(
        store = MemoryDirectStore(),
        clock = { now },
        identities = paths().let { _ ->
          object : DirectIdentities {
            override fun material(kind: IdentityKind): EnrolledMaterial? = device

            override fun stream(kind: IdentityKind) = null
          }
        },
        hubFleet = {
          Thread.sleep(500)
          HubReply.Failed("slow hub")
        },
        hubTrust = { HubReply.Failed("slow hub") },
        worker = worker
      ).also {
        closers += { it.shutdown() }
        it.setEnrolled(true)
      }
    val started = System.nanoTime()
    assertEquals(viewer(ViewerReason.NO_TRUST), paths.awaitPath(MACHINE))
    assertTrue((System.nanoTime() - started) / 1_000_000 < 200)
  }

  @Test fun theGateIsTheHubsViewOfTheCallerAndNothingIsTriedUntilItAnswers() {
    // Trust and the route are cached from before; the hub is reachable and says away.
    home = HubGate.AWAY
    val paths = paths(stored())
    assertEquals(viewer(ViewerReason.AWAY), paths.awaitPath(MACHINE))
    assertEquals(0, agent.requestCount)
  }

  @Test fun aDeviceThatIsNotEnrolledNeverContactsTheHubOrTheAgent() {
    val paths = paths()
    paths.setEnrolled(false)
    assertEquals(viewer(ViewerReason.NOT_ENROLLED), paths.awaitPath(MACHINE))
    Thread.sleep(150)
    assertEquals(0, agent.requestCount)
  }

  @Test fun coldStartWithoutTheHubUsesTheCachedRouteAndTrust() {
    home = null
    agent.enqueue(MockResponse().setBody(answer))
    val paths = paths(stored())
    assertEquals(ActivePath(true, IdentityKind.CURRENT), paths.awaitPath(MACHINE))
    assertEquals(1, agent.requestCount)
  }

  private fun silentAgent(): Pair<ServerSocket, AtomicInteger> {
    val socket = ServerSocket(0, 8, loopback)
    val accepted = AtomicInteger()
    val open = CopyOnWriteArrayList<Socket>()
    Thread {
      while (!socket.isClosed) {
        runCatching { open += socket.accept() }.onSuccess { accepted.incrementAndGet() }
      }
    }.apply { isDaemon = true }.start()
    closers += {
      socket.close()
      open.forEach { runCatching { it.close() } }
    }
    return socket to accepted
  }

  @Test fun withoutTheHubAProbeRunsOnceAndAFailureIsCachedForSixtySeconds() {
    home = null
    val (socket, accepted) = silentAgent()
    agentPort = socket.localPort
    val paths = paths(stored())
    assertEquals(viewer(ViewerReason.PROBE_FAILED), paths.awaitPath(MACHINE))
    assertEquals(1, accepted.get())
    repeat(5) { assertEquals(viewer(ViewerReason.PROBE_FAILED), paths.awaitPath(MACHINE)) }
    assertEquals(1, accepted.get())
    now += 59_000
    assertEquals(viewer(ViewerReason.PROBE_FAILED), paths.awaitPath(MACHINE))
    assertEquals(1, accepted.get())
    now += 2_000
    assertEquals(viewer(ViewerReason.PROBE_FAILED), paths.awaitPath(MACHINE))
    assertEquals(2, accepted.get())
  }

  @Test fun aNetworkChangeAllowsANewProbeAtOnce() {
    home = null
    val (socket, accepted) = silentAgent()
    agentPort = socket.localPort
    val paths = paths(stored())
    assertEquals(viewer(ViewerReason.PROBE_FAILED), paths.awaitPath(MACHINE))
    paths.networkChanged()
    assertEquals(viewer(ViewerReason.PROBE_FAILED), paths.awaitPath(MACHINE))
    assertEquals(2, accepted.get())
    assertTrue(fleetCalls.get() >= 2)
  }

  @Test fun aMachineWhosePathIsStillBeingDecidedIsReportedAsPending() {
    val (socket, _) = silentAgent()
    agentPort = socket.localPort
    val paths = paths(stored())
    paths.streamRouting("s", MACHINE)
    paths.streamClosed("s")
    // The hub contact and the probe run in the background: until they end the path is being chosen.
    val status = paths.status(MACHINE)
    assertFalse(status.direct)
    assertEquals(ViewerReason.PENDING, status.reason)
  }

  @Test fun aStalledHandshakeFallsBackWithinTheDeadline() {
    val (socket, _) = silentAgent()
    agentPort = socket.localPort
    val paths = paths()
    val started = System.nanoTime()
    assertEquals(viewer(ViewerReason.PROBE_FAILED), paths.awaitPath(MACHINE))
    val elapsedMs = (System.nanoTime() - started) / 1_000_000
    assertTrue("took $elapsedMs ms", elapsedMs < deadlines.connectMs + 800)
    assertEquals(FailureKind.TIMEOUT, paths.status(MACHINE).unreachable?.kind)
  }

  @Test fun aPeerThatCompletesTlsButNeverAnswersFallsBackWithinTheDeadlines() {
    agent.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
    val paths = paths()
    val started = System.nanoTime()
    assertEquals(viewer(ViewerReason.PROBE_FAILED), paths.awaitPath(MACHINE))
    val elapsedMs = (System.nanoTime() - started) / 1_000_000
    assertTrue("took $elapsedMs ms", elapsedMs < deadlines.connectMs + deadlines.responseMs + 800)
    assertEquals(FailureKind.TIMEOUT, paths.status(MACHINE).unreachable?.kind)
  }

  @Test fun aRequestThatWaitsLongerThanTheBoundGetsTheViewerHostWithoutACachedDecision() {
    val (socket, _) = silentAgent()
    agentPort = socket.localPort
    val paths = paths(maxWaitMs = 100)
    assertEquals(viewer(ViewerReason.PENDING), paths.awaitPath(MACHINE))
  }

  @Test fun trustThatIsAWeekOldTurnsTheDirectPathOff() {
    agent.enqueue(MockResponse().setBody(answer))
    val paths = paths()
    assertTrue(paths.awaitPath(MACHINE).direct)
    now += 7 * 24 * 60 * 60 * 1000L - 1
    assertTrue(paths.awaitPath(MACHINE).direct)
    now += 1
    home = null
    assertEquals(viewer(ViewerReason.TRUST_EXPIRED), paths.awaitPath(MACHINE))
  }

  @Test fun aFailedDirectRequestSendsTheMachineToTheViewerHostAndAnUnknownOutcomeIsKept() {
    agent.enqueue(MockResponse().setBody(answer))
    val paths = paths()
    assertTrue(paths.awaitPath(MACHINE).direct)
    paths.unknownOutcome(MACHINE, "POST")
    paths.directFailed(MACHINE, IOException("reset"), freshConnection = false)
    val status = paths.status(MACHINE)
    assertFalse(status.direct)
    assertEquals(ViewerReason.PROBE_FAILED, status.reason)
    assertEquals("POST", status.unknownOutcomeMethod)
    assertNull(status.failure)
    assertEquals(viewer(ViewerReason.PROBE_FAILED), paths.awaitPath(MACHINE))
    assertTrue(changes.any { it.wasDirect && !it.isDirect })
  }

  @Test fun aStreamGetsTheCheckingListenerOnlyOnTheDirectPath() {
    agent.enqueue(MockResponse().setBody(answer))
    val paths = paths()
    assertNull(
      "not decided yet: the stream uses the viewer host",
      paths.streamRouting("s0", MACHINE)
    )
    paths.streamClosed("s0")
    assertTrue(paths.awaitPath(MACHINE).direct)
    val routing = paths.streamRouting("s1", MACHINE)!!
    assertTrue(routing.proxyPort > 0)
    assertEquals(VIEWER, routing.host)
    assertEquals(AGENT_IDENTITY, routing.agentIdentity)
    assertEquals(world.trust().caBundlePem, routing.caBundlePem)
    // A second stream of the same machine takes the same path while the first is open.
    assertEquals(routing.proxyPort, paths.streamRouting("s2", MACHINE)!!.proxyPort)
    paths.streamClosed("s1")
    paths.streamClosed("s2")
    Thread.sleep(400)
    assertTrue(
      runCatching {
        Socket().connect(InetSocketAddress(loopback, routing.proxyPort), 300)
      }.isFailure
    )
  }

  @Test fun theCheckingListenerRefusesAnAgentThatFailsTheAgentCheck() {
    agent.shutdown()
    agent =
      agentServer(world.agentLeaf(identity = "agent-z-mac"), listOf(world.clients.certificate))
        .also { closers += { it.shutdown() } }
    agentPort = agent.port
    // The probe itself fails on the identity, so the machine is not direct and gets no listener.
    val paths = paths()
    assertEquals(viewer(ViewerReason.PROBE_FAILED), paths.awaitPath(MACHINE))
    assertEquals(FailureKind.CERTIFICATE, paths.status(MACHINE).failure?.kind)
    assertNull(paths.streamRouting("s", MACHINE))
  }

  @Test fun theLocalProxyStopsWhenNoMachineUsesTheDirectPath() {
    agent.enqueue(MockResponse().setBody(answer))
    val paths = paths()
    assertTrue(paths.awaitPath(MACHINE).direct)
    val address = paths.relayAddress()!!
    paths.directFailed(MACHINE, IOException("reset"), freshConnection = false)
    Thread.sleep(600)
    assertNull(paths.relayAddress())
    assertTrue(runCatching { Socket().connect(address, 300) }.isFailure)
  }
  // ---- a hub outage: unreachable, or a front that answers 503 with no backend behind it ----

  @Test fun anAwayVerdictLapsesWhenTheHubStopsAnswering() {
    home = HubGate.AWAY
    val paths = paths(stored())
    assertEquals(viewer(ViewerReason.AWAY), paths.awaitPath(MACHINE))
    assertEquals(0, agent.requestCount)
    // The hub goes away behind a front that answers 503; its old verdict is all the phone has left.
    agent.enqueue(MockResponse().setBody(answer))
    home = null
    hubDetail = "The hub answered HTTP 503."
    awaitUntil {
      paths.refreshHub(force = true)
      paths.status(MACHINE).reason != ViewerReason.AWAY
    }
    assertEquals(directNow, paths.awaitPath(MACHINE))
    assertEquals(1, agent.requestCount)
  }

  @Test fun anAwayVerdictStillBlocksWhileTheHubKeepsAnswering() {
    home = HubGate.AWAY
    val paths = paths(stored())
    assertEquals(viewer(ViewerReason.AWAY), paths.awaitPath(MACHINE))
    repeat(3) {
      val before = fleetCalls.get()
      awaitUntil {
        paths.refreshHub(force = true)
        fleetCalls.get() > before
      }
    }
    assertEquals(viewer(ViewerReason.AWAY), paths.awaitPath(MACHINE))
    assertEquals(0, agent.requestCount)
  }

  @Test fun aRequestThatMeetsAnOldAwayVerdictAsksTheHubAgainWhichNoticesAnOutage() {
    home = HubGate.AWAY
    val paths = paths(stored())
    assertEquals(viewer(ViewerReason.AWAY), paths.awaitPath(MACHINE))
    // Soon after the verdict a request does not ask again; long after it, it does. The hub is down
    // by then, and the request itself keeps the viewer host while the contact finds that out.
    val calls = fleetCalls.get()
    assertEquals(viewer(ViewerReason.AWAY), paths.awaitPath(MACHINE))
    assertEquals(calls, fleetCalls.get())
    agent.enqueue(MockResponse().setBody(answer))
    home = null
    hubDetail = "The hub answered HTTP 503."
    now += 31_000
    assertEquals(viewer(ViewerReason.AWAY), paths.awaitPath(MACHINE))
    awaitUntil { paths.status(MACHINE).reason != ViewerReason.AWAY }
    assertEquals(directNow, paths.awaitPath(MACHINE))
    assertEquals(1, agent.requestCount)
  }

  @Test fun aNetworkChangeDuringAnOutageProbesWithoutAnyHubAnswer() {
    home = null
    hubDetail = "The hub answered HTTP 503."
    agent.enqueue(MockResponse().setBody(answer))
    agent.enqueue(MockResponse().setBody(answer))
    val paths = paths(stored())
    assertEquals(directNow, paths.awaitPath(MACHINE))
    paths.networkChanged()
    assertEquals(directNow, paths.awaitPath(MACHINE))
    assertEquals(2, agent.requestCount)
    assertTrue(paths.status(MACHINE).direct)
  }

  @Test fun aSlowHubDoesNotHoldTheProbeBack() {
    slowHubMs = 3_000
    agent.enqueue(MockResponse().setBody(answer))
    val paths = paths(stored(), hubWaitMs = 100)
    val started = System.nanoTime()
    assertEquals(directNow, paths.awaitPath(MACHINE))
    val elapsedMs = (System.nanoTime() - started) / 1_000_000
    assertTrue("took $elapsedMs ms", elapsedMs < 2_000)
    assertEquals(1, agent.requestCount)
  }

  @Test fun aNetworkChangeDuringAHubContactGetsItsOwnContactWithoutAnyRequest() {
    val release = CountDownLatch(1)
    fleetHook = { call -> if (call == 1) release.await(5, TimeUnit.SECONDS) }
    val paths = paths(stored())
    awaitUntil { fleetCalls.get() == 1 }
    paths.networkChanged()
    release.countDown()
    awaitUntil { fleetCalls.get() >= 2 }
  }

  // ---- a direct connection that broke ----

  @Test fun aBrokenDirectConnectionIsProbedAgainAtOnceAndKeepsTheDirectPathWhenTheAgentAnswers() {
    home = null
    agent.enqueue(MockResponse().setBody(answer))
    agent.enqueue(MockResponse().setBody(answer))
    val paths = paths(stored())
    assertEquals(directNow, paths.awaitPath(MACHINE))
    now += 60_000
    paths.directFailed(MACHINE, IOException("connection reset"), freshConnection = false)
    assertTrue("the decision stays while the probe runs", paths.status(MACHINE).direct)
    awaitUntil { agent.requestCount == 2 }
    awaitUntil { !paths.status(MACHINE).probing }
    val status = paths.status(MACHINE)
    assertTrue(status.direct)
    assertNull(status.unreachable)
    assertEquals(directNow, paths.awaitPath(MACHINE))
    assertEquals(2, agent.requestCount)
    assertFalse(changes.any { it.wasDirect && !it.isDirect })
  }

  @Test fun aBrokenDirectConnectionWhoseProbeFailsTooIsCachedForSixtySeconds() {
    home = null
    agent.enqueue(MockResponse().setBody(answer))
    val paths = paths(stored())
    assertEquals(directNow, paths.awaitPath(MACHINE))
    agent.shutdown()
    now += 60_000
    paths.directFailed(MACHINE, IOException("connection reset"), freshConnection = false)
    awaitUntil { paths.status(MACHINE).reason == ViewerReason.PROBE_FAILED }
    assertEquals(viewer(ViewerReason.PROBE_FAILED), paths.awaitPath(MACHINE))
    assertEquals(FailureKind.UNREACHABLE, paths.status(MACHINE).unreachable?.kind)
  }

  @Test fun aCachedDirectDecisionBringsTheStoppedProxyBack() {
    agent.enqueue(MockResponse().setBody(answer))
    val paths = paths()
    assertEquals(directNow, paths.awaitPath(MACHINE))
    home = HubGate.AWAY
    awaitUntil {
      paths.refreshHub(force = true)
      paths.status(MACHINE).reason == ViewerReason.AWAY
    }
    awaitUntil { paths.relayAddress() == null }
    home = HubGate.HOME
    awaitUntil {
      paths.refreshHub(force = true)
      paths.status(MACHINE).direct
    }
    assertEquals(directNow, paths.awaitPath(MACHINE))
    assertNotNull("a direct decision needs a proxy to dial through", paths.relayAddress())
    assertEquals(1, agent.requestCount)
  }
}
