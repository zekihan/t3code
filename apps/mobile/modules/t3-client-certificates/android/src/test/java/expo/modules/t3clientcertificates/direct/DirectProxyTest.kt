package expo.modules.t3clientcertificates.direct

import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A TCP server standing in for an agent's direct listener: it echoes what it receives. */
internal class EchoServer {
  val socket = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
  val port get() = socket.localPort
  val accepted = AtomicInteger()
  private val open = CopyOnWriteArrayList<Socket>()

  init {
    Thread {
      while (!socket.isClosed) {
        val client =
          try {
            socket.accept()
          } catch (_: java.io.IOException) {
            break
          }
        accepted.incrementAndGet()
        open += client
        Thread {
          try {
            val input = client.getInputStream()
            val output = client.getOutputStream()
            val buffer = ByteArray(1024)
            while (true) {
              val read = input.read(buffer)
              if (read < 0) break
              output.write(buffer, 0, read)
              output.flush()
            }
          } catch (_: java.io.IOException) {
          } finally {
            runCatching { client.close() }
          }
        }.apply { isDaemon = true }.start()
      }
    }.apply { isDaemon = true }.start()
  }

  fun close() {
    runCatching { socket.close() }
    open.forEach { runCatching { it.close() } }
  }
}

class DirectProxyTest {
  private lateinit var echo: EchoServer
  private lateinit var proxy: DirectProxy
  private val loopback = InetAddress.getByName("127.0.0.1")

  private fun newProxy(
    check: ((ProxyTarget) -> PeerVerdict)? = null,
    limits: ProxyLimits = ProxyLimits(headerTimeoutMs = 500, connectTimeoutMs = 500),
    routes: Set<String> = setOf("z-arch"),
    onRefused: (String, PeerVerdict.Refused) -> Unit = { _, _ -> }
  ) =
    DirectProxy(
      resolve = { host, port ->
        val machine = machineOfViewerHost(host)
        if (port == 443 && machine in routes) ProxyTarget(machine!!, loopback, echo.port) else null
      },
      check = check,
      limits = limits,
      onRefused = onRefused
    )

  @Before fun start() {
    echo = EchoServer()
    proxy = newProxy()
    proxy.start()
  }

  @After fun stop() {
    proxy.stop()
    echo.close()
  }

  private fun connect(p: DirectProxy = proxy) =
    Socket().apply {
      connect(InetSocketAddress(loopback, p.port), 1000)
      soTimeout = 2000
    }

  private fun readHead(input: InputStream): String {
    val out = StringBuilder()
    while (!out.endsWith("\r\n\r\n")) {
      val next = input.read()
      if (next < 0) break
      out.append(next.toChar())
    }
    return out.toString()
  }

  private fun send(raw: String): String =
    connect().use { socket ->
      socket.getOutputStream().apply {
        write(raw.toByteArray(Charsets.ISO_8859_1))
        flush()
      }
      readHead(socket.getInputStream())
    }

  private fun connectRequest(authority: String) =
    "CONNECT $authority HTTP/1.1\r\nHost: $authority\r\nProxy-Connection: Keep-Alive\r\n\r\n"

  @Test fun bindsOnlyTheLoopbackInterfaceOnARandomPort() {
    assertTrue(proxy.port in 1024..65535)
    assertTrue(proxy.isProxyEndpoint(loopback, proxy.port))
    assertFalse(proxy.isProxyEndpoint(loopback, proxy.port + 1))
    assertFalse(proxy.isProxyEndpoint(InetAddress.getByName("192.168.2.1"), proxy.port))
    val other = DirectProxy({ _, _ -> null }).apply { start() }
    try {
      assertTrue(other.port != proxy.port)
    } finally {
      other.stop()
    }
  }

  @Test fun relaysRawBytesBothWaysForAnAllowedTarget() {
    connect().use { socket ->
      socket.getOutputStream().write(connectRequest("t3.z-arch.mesh.noqer.com:443").toByteArray())
      assertTrue(readHead(socket.getInputStream()).startsWith("HTTP/1.1 200"))
      val payload = ByteArray(100_000) { (it % 251).toByte() }
      socket.getOutputStream().write(payload)
      val echoed = ByteArray(payload.size)
      var at = 0
      while (at < echoed.size) {
        val read = socket.getInputStream().read(echoed, at, echoed.size - at)
        if (read < 0) break
        at += read
      }
      assertEquals(payload.size, at)
      assertTrue(payload.contentEquals(echoed))
    }
    assertEquals(1, echo.accepted.get())
  }

  @Test fun bytesSentRightAfterTheHeadReachThePeer() {
    connect().use { socket ->
      socket.getOutputStream().write(
        (connectRequest("t3.z-arch.mesh.noqer.com:443") + "early").toByteArray()
      )
      assertTrue(readHead(socket.getInputStream()).startsWith("HTTP/1.1 200"))
      val got = ByteArray(5)
      var at = 0
      while (at < 5) at += socket.getInputStream().read(got, at, 5 - at)
      assertEquals("early", String(got))
    }
  }

  @Test fun refusesEveryOtherHostPortAndMachineWithoutOpeningAConnection() {
    listOf(
      "evil.example.com:443",
      "t3.z-arch.mesh.noqer.com:80",
      "t3.z-arch.mesh.noqer.com:8443",
      "t3.z-mac.mesh.noqer.com:443",
      "hub.mesh.noqer.com:443",
      "127.0.0.1:${echo.port}",
      "192.168.2.41:27443",
      "T3.z-arch.mesh.noqer.com:443",
      "t3.z-arch.mesh.noqer.com",
      "t3.z-arch.mesh.noqer.com:",
      "t3.z-arch.mesh.noqer.com:443:1",
      "[::1]:443",
      "t3.z-arch.mesh.noqer.com:99999999"
    ).forEach { authority ->
      assertTrue(authority, send(connectRequest(authority)).startsWith("HTTP/1.1 403"))
    }
    assertEquals(0, echo.accepted.get())
  }

  @Test fun refusesEveryOtherMethod() {
    listOf(
      "GET http://t3.z-arch.mesh.noqer.com/ HTTP/1.1\r\nHost: t3.z-arch.mesh.noqer.com\r\n\r\n",
      "POST http://t3.z-arch.mesh.noqer.com/ HTTP/1.1\r\n\r\n",
      "OPTIONS * HTTP/1.1\r\n\r\n",
      "connect t3.z-arch.mesh.noqer.com:443 HTTP/1.1\r\n\r\n"
    ).forEach { assertTrue(it, send(it).startsWith("HTTP/1.1 405")) }
    assertEquals(0, echo.accepted.get())
  }

  @Test fun answersGarbageWithBadRequestOrNothing() {
    listOf(
      "\u0000\u0001\u0002garbage\r\n\r\n",
      "CONNECT\r\n\r\n",
      "CONNECT a b c d\r\n\r\n",
      "CONNECT t3.z-arch.mesh.noqer.com:443 FTP/1.1\r\n\r\n",
      "CONNECT t3.z-arch.mesh.noqer.com:443  HTTP/1.1\r\n\r\n",
      "\r\n\r\n",
      "CONNECT t3.z-arch.mesh.noqer.com:443 HTTP/1.1\r\nX: é\r\n\r\n"
    ).forEach {
      assertTrue(
        it,
        send(it).let { head ->
          head.isEmpty() ||
            head.startsWith("HTTP/1.1 400")
        }
      )
    }
    assertEquals(0, echo.accepted.get())
  }

  @Test fun closesAHeadThatNeverEndsAndRefusesOneThatIsTooLong() {
    connect().use { socket ->
      socket.getOutputStream().write(
        "CONNECT t3.z-arch.mesh.noqer.com:443 HTTP/1.1\r\n".toByteArray()
      )
      assertEquals(-1, socket.getInputStream().read())
    }
    connect().use { socket ->
      socket.getOutputStream().write(("GET / HTTP/1.1\r\nX: " + "a".repeat(9000)).toByteArray())
      // The refusal may be lost to a reset, since the rest of the head was never read.
      val head = runCatching { readHead(socket.getInputStream()) }.getOrDefault("")
      assertTrue(head, head.isEmpty() || head.startsWith("HTTP/1.1 400"))
    }
    assertEquals(0, echo.accepted.get())
  }

  @Test fun answersBadGatewayWhenThePeerCannotBeReached() {
    val dead = ServerSocket(0, 1, loopback).use { it.localPort }
    val unreachable =
      DirectProxy({ host, port ->
        machineOfViewerHost(host)?.takeIf { port == 443 }?.let { ProxyTarget(it, loopback, dead) }
      }, limits = ProxyLimits(headerTimeoutMs = 500, connectTimeoutMs = 500)).apply { start() }
    try {
      val head =
        connect(unreachable).use { socket ->
          socket.getOutputStream().write(
            connectRequest("t3.z-arch.mesh.noqer.com:443").toByteArray()
          )
          readHead(socket.getInputStream())
        }
      assertTrue(head.startsWith("HTTP/1.1 502"))
    } finally {
      unreachable.stop()
    }
  }

  @Test fun refusesConnectionsBeyondTheLimit() {
    val small = newProxy(limits = ProxyLimits(headerTimeoutMs = 2000, maxTunnels = 1)).apply {
      start()
    }
    try {
      val first = connect(small)
      first.getOutputStream().write(connectRequest("t3.z-arch.mesh.noqer.com:443").toByteArray())
      assertTrue(readHead(first.getInputStream()).startsWith("HTTP/1.1 200"))
      val second = connect(small)
      assertTrue(readHead(second.getInputStream()).startsWith("HTTP/1.1 503"))
      first.close()
      second.close()
    } finally {
      small.stop()
    }
  }

  @Test fun closingTunnelsOfOneMachineLeavesTheOthersOpen() {
    val both = newProxy(routes = setOf("z-arch", "z-mac")).apply { start() }
    try {
      val arch = connect(both)
      val mac = connect(both)
      arch.getOutputStream().write(connectRequest("t3.z-arch.mesh.noqer.com:443").toByteArray())
      mac.getOutputStream().write(connectRequest("t3.z-mac.mesh.noqer.com:443").toByteArray())
      readHead(arch.getInputStream())
      readHead(mac.getInputStream())
      both.closeTunnels("z-arch")
      assertEquals(-1, arch.getInputStream().read())
      mac.getOutputStream().write(byteArrayOf(7))
      assertEquals(7, mac.getInputStream().read())
      both.stop()
      assertEquals(-1, mac.getInputStream().read())
      arch.close()
      mac.close()
    } finally {
      both.stop()
    }
  }

  @Test fun aCheckingProxyRelaysOnlyAfterThePeerPassedTheCheck() {
    val verdicts = mutableListOf<String>()
    val refused = mutableListOf<String>()
    var next: PeerVerdict = PeerVerdict.Accepted
    val checking =
      newProxy(
        check = { target ->
          verdicts += target.machine
          next
        },
        onRefused = { machine, why -> refused += "$machine:${why.failure.code}" }
      ).apply { start() }
    try {
      connect(checking).use { socket ->
        socket.getOutputStream().write(connectRequest("t3.z-arch.mesh.noqer.com:443").toByteArray())
        assertTrue(readHead(socket.getInputStream()).startsWith("HTTP/1.1 200"))
      }
      next = PeerVerdict.Refused(AgentFailure.WRONG_IDENTITY, "other agent")
      val before = echo.accepted.get()
      connect(checking).use { socket ->
        socket.getOutputStream().write(connectRequest("t3.z-arch.mesh.noqer.com:443").toByteArray())
        val head = readHead(socket.getInputStream())
        assertTrue(head.startsWith("HTTP/1.1 502"))
        assertTrue(head.contains("X-T3-Direct-Check: wrong-identity"))
      }
      next = PeerVerdict.Unreachable("silent")
      connect(checking).use { socket ->
        socket.getOutputStream().write(connectRequest("t3.z-arch.mesh.noqer.com:443").toByteArray())
        assertTrue(readHead(socket.getInputStream()).startsWith("HTTP/1.1 502"))
      }
      assertEquals(before, echo.accepted.get())
      assertEquals(listOf("z-arch:wrong-identity"), refused)
      assertEquals(3, verdicts.size)
      // A target that is not allowed is never even checked.
      connect(checking).use { socket ->
        socket.getOutputStream().write(connectRequest("evil.example.com:443").toByteArray())
        assertTrue(readHead(socket.getInputStream()).startsWith("HTTP/1.1 403"))
      }
      assertEquals(3, verdicts.size)
    } finally {
      checking.stop()
    }
  }

  @Test fun stoppingClosesTheListenerAndRestartingUsesANewOne() {
    val oldPort = proxy.port
    proxy.stop()
    assertEquals(0, proxy.port)
    assertFalse(proxy.isRunning)
    assertTrue(
      runCatching {
        Socket().connect(InetSocketAddress(loopback, oldPort), 500)
      }.isFailure
    )
    assertTrue(proxy.start() > 0)
    assertTrue(proxy.isRunning)
  }
}
