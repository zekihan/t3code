package expo.modules.t3clientcertificates.direct

import expo.modules.t3clientcertificates.SelectedIdentity
import expo.modules.t3clientcertificates.enroll.EnrolledMaterial
import java.net.InetAddress
import java.net.Socket
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSession
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

private const val TLS_13 = "TLSv1.3"

/**
 * Direct connections need TLS 1.3, so the client certificate is encrypted. A peer that offers less
 * fails the handshake and the request goes through the viewer host.
 */
internal class Tls13OnlyFactory(private val delegate: SSLSocketFactory) : SSLSocketFactory() {
  override fun getDefaultCipherSuites(): Array<String> = delegate.defaultCipherSuites

  override fun getSupportedCipherSuites(): Array<String> = delegate.supportedCipherSuites

  override fun createSocket(socket: Socket, host: String, port: Int, autoClose: Boolean): Socket =
    restrict(delegate.createSocket(socket, host, port, autoClose))

  override fun createSocket(host: String, port: Int): Socket =
    restrict(delegate.createSocket(host, port))

  override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket =
    restrict(delegate.createSocket(host, port, local, localPort))

  override fun createSocket(host: InetAddress, port: Int): Socket =
    restrict(delegate.createSocket(host, port))

  override fun createSocket(
    host: InetAddress,
    port: Int,
    local: InetAddress,
    localPort: Int
  ): Socket = restrict(delegate.createSocket(host, port, local, localPort))

  private fun restrict(socket: Socket): Socket =
    socket.also { (it as? SSLSocket)?.enabledProtocols = arrayOf(TLS_13) }
}

/** Builds the TLS pieces of a direct connection: the agent check as trust, the enrolled identity. */
internal class DirectTls(
  private val trust: () -> DirectTrust?,
  private val clock: () -> Long = System::currentTimeMillis
) {
  private var cached: Triple<DirectTrust, String, AgentCheck>? = null

  /** The check for [route]'s agent against the newest cached trust, or null without trust. */
  @Synchronized
  fun checkFor(route: DirectRoute): AgentCheck? {
    val current = trust() ?: return null
    val hit = cached?.takeIf { it.first === current && it.second == route.agentIdentity }
    return hit?.third
      ?: AgentCheck(current.caBundlePem, current.revoked, route.agentIdentity, clock).also {
        cached = Triple(current, route.agentIdentity, it)
      }
  }

  fun trustManager(route: DirectRoute, observed: (AgentCheckResult) -> Unit = {}) =
    AgentTrustManager({ checkFor(route) }, observed)

  /** A socket factory presenting [material], and accepting only the agent check of [route]. */
  fun socketFactory(
    route: DirectRoute,
    material: EnrolledMaterial,
    manager: AgentTrustManager = trustManager(route)
  ): SSLSocketFactory {
    val context =
      SSLContext.getInstance("TLS").apply {
        init(
          arrayOf(SelectedIdentity(material.alias, material.key, material.chain)),
          arrayOf(manager),
          null
        )
      }
    return Tls13OnlyFactory(context.socketFactory)
  }

  /** A factory with no client identity, for checking the peer's certificate alone. */
  fun anonymousFactory(manager: AgentTrustManager): SSLSocketFactory =
    Tls13OnlyFactory(
      SSLContext.getInstance("TLS").apply { init(null, arrayOf(manager), null) }.socketFactory
    )
}

/**
 * Accepts what [base] accepts, and a connection to a machine's viewer host whose peer passes the
 * agent check: a direct connection has no name to compare, and its certificate has been through
 * the agent check in the handshake already. Any other mismatch is still refused.
 */
internal class DirectHostnameVerifier(
  private val base: HostnameVerifier,
  private val agentCheckFor: (host: String) -> AgentCheck?
) : HostnameVerifier {
  override fun verify(host: String, session: SSLSession): Boolean =
    base.verify(host, session) || agentAccepts(host, session)

  private fun agentAccepts(host: String, session: SSLSession): Boolean {
    val check = agentCheckFor(host)
    val chain =
      try {
        session.peerCertificates.filterIsInstance<X509Certificate>()
      } catch (_: javax.net.ssl.SSLPeerUnverifiedException) {
        emptyList()
      }
    return check != null && check.check(chain) is AgentCheckResult.Accepted
  }
}
