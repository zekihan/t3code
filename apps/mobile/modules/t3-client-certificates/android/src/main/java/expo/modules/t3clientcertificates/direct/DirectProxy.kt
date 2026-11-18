package expo.modules.t3clientcertificates.direct

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

/** Where one allowed `CONNECT` goes: the machine's LAN address and direct port. */
internal class ProxyTarget(val machine: String, val address: InetAddress, val port: Int)

/** What a listener that checks the peer first decides about a target. */
internal sealed interface PeerVerdict {
  data object Accepted : PeerVerdict

  data class Refused(val failure: AgentFailure, val detail: String) : PeerVerdict

  /** The peer could not be reached or did not complete TLS in time. */
  data class Unreachable(val detail: String) : PeerVerdict
}

internal data class ProxyLimits(
  val connectTimeoutMs: Int = 2_000,
  val headerTimeoutMs: Int = 5_000,
  val maxHeaderBytes: Int = 8_192,
  val maxTunnels: Int = 64
)

/**
 * A CONNECT proxy on the loopback interface, random port, for one purpose: turning
 * `CONNECT t3.<machine>.mesh.noqer.com:443` into a TCP connection to that machine's LAN address and
 * direct port. TLS stays end to end between the app (or a stream WebView) and the agent. Nothing
 * else is relayed: other methods, other hosts, other ports and a machine without a cached route are
 * refused, and so is anything that is not a plain request head.
 *
 * With [check] the proxy first completes its own handshake with the peer and runs the agent check
 * before it relays the caller's connection to the same address. That is for WebView callers,
 * which validate certificates against the system store and would otherwise accept a peer with a
 * publicly valid certificate without any agent check.
 */
internal class DirectProxy(
  private val resolve: (host: String, port: Int) -> ProxyTarget?,
  private val check: ((ProxyTarget) -> PeerVerdict)? = null,
  private val limits: ProxyLimits = ProxyLimits(),
  /** Called when a check refused a peer, with the machine's name. */
  private val onRefused: (machine: String, PeerVerdict.Refused) -> Unit = { _, _ -> },
  private val onUnreachable: (machine: String, PeerVerdict.Unreachable) -> Unit = { _, _ -> }
) {
  private val tunnels = ConcurrentHashMap<Socket, String>()
  private val slots = Semaphore(limits.maxTunnels)

  @Volatile private var server: ServerSocket? = null
  private val executor =
    Executors.newCachedThreadPool { runnable ->
      Thread(runnable, "t3-direct-proxy").apply { isDaemon = true }
    }

  /** The port, or 0 while stopped. */
  val port: Int get() = server?.localPort ?: 0

  val openTunnels: Int get() = tunnels.size

  val isRunning: Boolean get() = server != null

  /** True when [socket] is a connection to this proxy; how a TLS layer tells a direct tunnel. */
  fun isProxyEndpoint(address: InetAddress?, remotePort: Int) =
    isRunning && remotePort == port && address?.isLoopbackAddress == true

  @Synchronized
  fun start(): Int {
    server?.let { return it.localPort }
    val socket = ServerSocket(0, BACKLOG, InetAddress.getByAddress(LOOPBACK))
    server = socket
    executor.execute { accept(socket) }
    return socket.localPort
  }

  @Synchronized
  fun stop() {
    val socket = server ?: return
    server = null
    runCatching { socket.close() }
    closeTunnels(null)
  }

  /** Closes open tunnels of one machine, or all of them. */
  fun closeTunnels(machine: String?) {
    tunnels.entries.filter { machine == null || it.value == machine }.forEach {
      runCatching { it.key.close() }
    }
  }

  private fun accept(socket: ServerSocket) {
    while (!socket.isClosed) {
      val client =
        try {
          socket.accept()
        } catch (_: IOException) {
          return
        }
      if (!slots.tryAcquire()) {
        respond(client, "503 Service Unavailable")
        continue
      }
      try {
        executor.execute { serve(client) }
      } catch (_: RejectedExecutionException) {
        slots.release()
        runCatching { client.close() }
      }
    }
  }

  private fun serve(client: Socket) {
    try {
      handle(client)
    } catch (_: IOException) {
      // The caller or the peer went away; both sockets are closed below.
    } finally {
      runCatching { client.close() }
      slots.release()
    }
  }

  @Suppress("ReturnCount") // Each refusal answers and ends the connection.
  private fun handle(client: Socket) {
    if (client.inetAddress?.isLoopbackAddress != true) return
    val request = readHead(client)
    val authority =
      when {
        request == null -> return respond(client, "400 Bad Request")
        request.method != "CONNECT" -> return respond(client, "405 Method Not Allowed")
        else -> request.authority
      }
    val target = authority?.let { resolveAuthority(it) }
    if (target == null) return respond(client, "403 Forbidden")
    if (check != null && !verified(client, target)) return
    val peer = connect(target) ?: return respond(client, "502 Bad Gateway")
    try {
      client.soTimeout = 0
      client.getOutputStream().apply {
        write(ESTABLISHED.toByteArray(Charsets.US_ASCII))
        flush()
      }
      relay(client, peer, target.machine)
    } finally {
      runCatching { peer.close() }
    }
  }

  private fun resolveAuthority(authority: String): ProxyTarget? {
    val colon = authority.lastIndexOf(':')
    if (colon <= 0 || colon != authority.indexOf(':')) return null
    val port = authority.substring(colon + 1).takeIf { it.length in 1..5 }?.toIntOrNull()
    return port?.let { resolve(authority.substring(0, colon), it) }
  }

  // Refuses the caller when the peer fails the check; false means the answer was already sent.
  private fun verified(client: Socket, target: ProxyTarget): Boolean =
    when (val verdict = check!!.invoke(target)) {
      PeerVerdict.Accepted -> true
      is PeerVerdict.Refused -> {
        onRefused(target.machine, verdict)
        respond(client, "502 Bad Gateway", "X-T3-Direct-Check: ${verdict.failure.code}")
        false
      }
      is PeerVerdict.Unreachable -> {
        onUnreachable(target.machine, verdict)
        respond(client, "502 Bad Gateway")
        false
      }
    }

  private fun connect(target: ProxyTarget): Socket? {
    val peer = Socket()
    return try {
      peer.tcpNoDelay = true
      peer.keepAlive = true
      peer.connect(InetSocketAddress(target.address, target.port), limits.connectTimeoutMs)
      peer
    } catch (_: IOException) {
      runCatching { peer.close() }
      null
    }
  }

  private fun relay(client: Socket, peer: Socket, machine: String) {
    tunnels[client] = machine
    tunnels[peer] = machine
    val downstreamDone = CountDownLatch(1)
    try {
      executor.execute {
        pump(client.getInputStream(), peer.getOutputStream(), peer)
        // The caller is finished sending; the peer gets a short while to finish answering.
        if (!downstreamDone.await(FIN_GRACE_SECONDS, TimeUnit.SECONDS)) {
          closeQuietly(client)
          closeQuietly(peer)
        }
      }
      pump(peer.getInputStream(), client.getOutputStream(), client)
    } catch (_: RejectedExecutionException) {
      // Shutting down.
    } finally {
      downstreamDone.countDown()
      tunnels.remove(client)
      tunnels.remove(peer)
      closeQuietly(client)
      closeQuietly(peer)
    }
  }

  private fun pump(from: InputStream, to: OutputStream, towards: Socket) {
    val buffer = ByteArray(BUFFER)
    try {
      while (true) {
        val read = from.read(buffer)
        if (read < 0) break
        to.write(buffer, 0, read)
        to.flush()
      }
    } catch (_: SocketException) {
      // Closed from the other side.
    } catch (_: IOException) {
      // Same.
    } finally {
      runCatching { towards.shutdownOutput() }
    }
  }

  private fun closeQuietly(socket: Socket) {
    runCatching { socket.close() }
  }

  private class RequestHead(val method: String, val authority: String?)

  // Reads the request head one byte at a time so nothing after it is consumed, within one overall
  // deadline. Null for anything that is not a well-formed head within the size limit.
  @Suppress("ReturnCount")
  private fun readHead(client: Socket): RequestHead? {
    val input = client.getInputStream()
    val deadline =
      System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(limits.headerTimeoutMs.toLong())
    val bytes = java.io.ByteArrayOutputStream()
    var tail = 0
    while (bytes.size() < limits.maxHeaderBytes) {
      val left = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
      if (left <= 0) return null
      client.soTimeout = left.toInt()
      val next = input.read()
      if (next < 0) return null
      bytes.write(next)
      tail = (tail shl 8) or next
      if (tail == CRLF_CRLF) return parseHead(bytes.toByteArray())
    }
    return null
  }

  @Suppress("ReturnCount")
  private fun parseHead(head: ByteArray): RequestHead? {
    if (head.any { it < 0 }) return null
    val text = String(head, Charsets.US_ASCII)
    val line = text.substringBefore("\r\n")
    val parts = line.split(' ')
    if (parts.size != 3 || !parts[2].startsWith("HTTP/1.")) return null
    if (parts.any { it.isEmpty() } || text.contains('\u0000')) return null
    return RequestHead(parts[0], parts[1].takeIf { parts[0] == "CONNECT" })
  }

  private fun respond(client: Socket, status: String, vararg headers: String) {
    try {
      val head = buildString {
        append("HTTP/1.1 ").append(status).append("\r\n")
        headers.forEach { append(it).append("\r\n") }
        append("Content-Length: 0\r\nConnection: close\r\n\r\n")
      }
      client.soTimeout = RESPOND_TIMEOUT_MS
      client.getOutputStream().apply {
        write(head.toByteArray(Charsets.US_ASCII))
        flush()
      }
    } catch (_: IOException) {
      // The caller is gone.
    } finally {
      runCatching { client.close() }
    }
  }

  private companion object {
    const val BACKLOG = 16
    const val BUFFER = 16 * 1024
    const val CRLF_CRLF = 0x0D0A0D0A
    const val FIN_GRACE_SECONDS = 30L
    const val RESPOND_TIMEOUT_MS = 2_000
    const val ESTABLISHED = "HTTP/1.1 200 Connection established\r\n\r\n"
    val LOOPBACK = byteArrayOf(127, 0, 0, 1)
  }
}
