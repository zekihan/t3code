package expo.modules.t3clientcertificates.enroll

import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import okhttp3.OkHttpClient

/** The hub's enrollment host: TLS passthrough to the hub, the only path open without a client certificate. */
internal const val ENROLL_HOST = "mesh.noqer.com"
private const val ENROLL_PORT = 443
private const val CONNECT_TIMEOUT_MS = 10_000
private const val EXCHANGE_TIMEOUT_MS = 30_000

/** The hub gives a whole enrollment exchange 30 s (`exchangeTimeout`). */
internal data class EnrollTimeouts(
  val connectMs: Int = CONNECT_TIMEOUT_MS,
  val exchangeMs: Int = EXCHANGE_TIMEOUT_MS
)

/** Sends one `Enroll` and returns the hub's `Enrolled`, or throws an [EnrollmentException]. */
internal fun interface EnrollExchange {
  fun exchange(token: String, csrPem: String): EnrollWire.Reply.Enrolled
}

/**
 * The enrollment client: TLS with ALPN `t3-mesh-enroll/1`, no client certificate, the hub's
 * certificate verified with the system trust roots and the exact host name.
 */
internal class EnrollmentClient(
  private val host: String = ENROLL_HOST,
  private val port: Int = ENROLL_PORT,
  /** Where to connect; [host] stays the TLS server name and the name the certificate must carry. */
  private val dial: String = host,
  private val tls: SSLSocketFactory = systemTlsFactory(),
  private val hostnameVerifier: HostnameVerifier = OkHttpClient().hostnameVerifier,
  private val timeouts: EnrollTimeouts = EnrollTimeouts()
) : EnrollExchange {
  override fun exchange(token: String, csrPem: String): EnrollWire.Reply.Enrolled {
    val request =
      try {
        EnrollWire.enrollRequest(token, csrPem)
      } catch (error: IOException) {
        throw enrollmentError(EnrollCode.CSR_REJECTED, error.message, error)
      }
    val deadline = System.currentTimeMillis() + timeouts.exchangeMs
    val reply = connectAndSend(request, deadline)
    return when (reply) {
      is EnrollWire.Reply.Enrolled -> reply
      is EnrollWire.Reply.Reject -> throw rejectException(reply.reason, reply.detail)
      is EnrollWire.Reply.Unexpected ->
        throw enrollmentError(EnrollCode.HUB_ERROR, "unexpected ${reply.type} answer")
    }
  }

  private fun connectAndSend(request: ByteArray, deadline: Long): EnrollWire.Reply {
    var phase = EnrollPhase.CONNECT
    val raw = Socket()
    try {
      raw.connect(InetSocketAddress(dial, port), timeouts.connectMs)
      phase = EnrollPhase.HANDSHAKE
      raw.soTimeout = remaining(deadline)
      val ssl = tls.createSocket(raw, host, port, true) as SSLSocket
      configure(ssl)
      ssl.startHandshake()
      verifyPeer(ssl)
      phase = EnrollPhase.EXCHANGE
      ssl.soTimeout = remaining(deadline)
      ssl.outputStream.write(request)
      ssl.outputStream.flush()
      return EnrollWire.readReply(ssl.inputStream)
    } catch (error: EnrollmentException) {
      throw error
    } catch (error: IOException) {
      throw classifyTransportFailure(phase, error)
    } finally {
      runCatching { raw.close() }
    }
  }

  private fun remaining(deadline: Long) =
    (deadline - System.currentTimeMillis()).toInt().coerceAtLeast(1)

  private fun configure(ssl: SSLSocket) {
    val parameters = ssl.sslParameters
    parameters.endpointIdentificationAlgorithm = "HTTPS"
    ssl.sslParameters = parameters
    Alpn.offer(ssl, EnrollWire.ALPN)
  }

  private fun verifyPeer(ssl: SSLSocket) {
    if (!hostnameVerifier.verify(host, ssl.session)) {
      throw enrollmentError(EnrollCode.TLS, "the certificate is not valid for $host")
    }
    if (Alpn.selected(ssl) != EnrollWire.ALPN) {
      throw enrollmentError(EnrollCode.HUB_ERROR, "the server does not offer device enrollment")
    }
  }
}

/** The platform trust managers, which apply the app's network security config. */
internal fun systemTlsFactory(): SSLSocketFactory =
  SSLContext.getInstance("TLS").apply { init(null, null, null) }.socketFactory

/**
 * ALPN through `SSLParameters` (Android 10 and newer, any current JDK), and through Conscrypt's own
 * socket methods before that.
 */
internal object Alpn {
  fun offer(socket: SSLSocket, protocol: String) {
    try {
      val parameters = socket.sslParameters
      parameters.applicationProtocols = arrayOf(protocol)
      socket.sslParameters = parameters
    } catch (_: NoSuchMethodError) {
      val encoded = byteArrayOf(protocol.length.toByte()) + protocol.toByteArray(Charsets.US_ASCII)
      socket.javaClass.getMethod("setAlpnProtocols", ByteArray::class.java).invoke(socket, encoded)
    }
  }

  fun selected(socket: SSLSocket): String? =
    try {
      socket.applicationProtocol?.takeIf { it.isNotEmpty() }
    } catch (_: NoSuchMethodError) {
      (socket.javaClass.getMethod("getAlpnSelectedProtocol").invoke(socket) as? ByteArray)
        ?.toString(Charsets.US_ASCII)
        ?.takeIf { it.isNotEmpty() }
    }
}
