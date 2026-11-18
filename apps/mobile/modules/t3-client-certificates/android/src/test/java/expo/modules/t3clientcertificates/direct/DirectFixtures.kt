package expo.modules.t3clientcertificates.direct

import expo.modules.t3clientcertificates.enroll.CLIENT_AUTH
import expo.modules.t3clientcertificates.enroll.EnrolledMaterial
import expo.modules.t3clientcertificates.enroll.SERVER_AUTH
import expo.modules.t3clientcertificates.enroll.TestCa
import expo.modules.t3clientcertificates.enroll.newKeyPair
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.security.KeyStore
import java.security.cert.X509Certificate
import javax.net.SocketFactory
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate

internal const val MACHINE = "z-arch"
internal const val VIEWER = "t3.z-arch.mesh.noqer.com"
internal const val AGENT_IDENTITY = "agent-z-arch"

private const val DAY = 24L * 60 * 60 * 1000

/** A clients CA with an agent that has a direct listener, and devices that may or may not be admitted. */
internal class DirectWorld {
  val clients = TestCa("clients CA")

  /** Devices issued by this CA are admitted by the agent; the agent trusts no other CA's devices. */
  fun device(
    ca: TestCa = clients,
    identity: String = "device-z-phone-mesh"
  ): EnrolledMaterial {
    val keys = newKeyPair()
    val now = System.currentTimeMillis()
    val leaf =
      ca.issue(
        keys.public,
        listOf("urn:noqer:mtls:clients:$identity"),
        notBefore = now - DAY,
        notAfter = now + 30 * DAY,
        usages = listOf(CLIENT_AUTH)
      )
    return EnrolledMaterial("device-$identity", keys.private, arrayOf(leaf, ca.certificate))
  }

  fun agentLeaf(
    ca: TestCa = clients,
    identity: String = AGENT_IDENTITY,
    usages: List<String> = listOf(SERVER_AUTH, CLIENT_AUTH)
  ): AgentLeaf {
    val keys = newKeyPair()
    val now = System.currentTimeMillis()
    val leaf =
      ca.issue(
        keys.public,
        listOf("urn:noqer:mtls:clients:$identity"),
        notBefore = now - DAY,
        notAfter = now + 30 * DAY,
        usages = usages
      )
    return AgentLeaf(leaf, keys.private, ca.certificate)
  }

  fun trust(revoked: Set<String> = emptySet()) =
    DirectTrust(clients.certificatePem, "rev-1", revoked, System.currentTimeMillis())

  val route =
    DirectRoute(MACHINE, "192.168.2.41", 27443, AGENT_IDENTITY, System.currentTimeMillis())
}

internal class AgentLeaf(
  val certificate: X509Certificate,
  val key: java.security.PrivateKey,
  val issuer: X509Certificate
)

/** An agent's direct listener: TLS, a certificate of the agent, the clients that [admits] may connect. */
internal fun agentServer(
  agent: AgentLeaf,
  admits: List<X509Certificate>,
  requireClient: Boolean = true
): MockWebServer {
  val keyStore = KeyStore.getInstance("PKCS12").apply { load(null, null) }
  keyStore.setKeyEntry("agent", agent.key, charArrayOf(), arrayOf(agent.certificate, agent.issuer))
  val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
    init(keyStore, charArrayOf())
  }
  val clientStore = KeyStore.getInstance("PKCS12").apply { load(null, null) }
  admits.forEachIndexed { index, certificate ->
    clientStore.setCertificateEntry("ca$index", certificate)
  }
  val trusts = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
    init(clientStore)
  }
  val context = SSLContext.getInstance("TLS").apply {
    init(keys.keyManagers, trusts.trustManagers, null)
  }
  return MockWebServer().apply {
    useHttps(context.socketFactory, false)
    if (requireClient) requireClientAuth() else requestClientAuth()
    protocols = listOf(Protocol.HTTP_1_1)
    start(InetAddress.getByName("127.0.0.1"), 0)
  }
}

/** The viewer host behind the cluster: a publicly trusted certificate for the viewer host's name. */
internal class ViewerFixture {
  private val ca = HeldCertificate.Builder().certificateAuthority(0).commonName("viewer CA").build()
  private val leaf =
    HeldCertificate.Builder().commonName(
      VIEWER
    ).addSubjectAlternativeName(VIEWER).signedBy(ca).build()
  private val serverTls = HandshakeCertificates.Builder().heldCertificate(
    leaf,
    ca.certificate
  ).build()
  val clientTls: HandshakeCertificates =
    HandshakeCertificates.Builder().addTrustedCertificate(ca.certificate).build()

  fun server(): MockWebServer =
    MockWebServer().apply {
      useHttps(serverTls.sslSocketFactory(), false)
      protocols = listOf(Protocol.HTTP_1_1)
      start(InetAddress.getByName("127.0.0.1"), 0)
    }
}

/**
 * Lets a test reach servers on other local ports through the real viewer name and port 443: the
 * viewer host resolves to loopback, and a connection to 443 goes to [viewerPort].
 */
internal fun OkHttpClient.Builder.viewerAt(viewerPort: Int): OkHttpClient.Builder =
  dns(
    object : Dns {
      override fun lookup(hostname: String) =
        if (hostname ==
          VIEWER
        ) {
          listOf(InetAddress.getByName("127.0.0.1"))
        } else {
          Dns.SYSTEM.lookup(hostname)
        }
    }
  ).socketFactory(
    object : SocketFactory() {
      private fun rewriting() =
        object : Socket() {
          override fun connect(endpoint: SocketAddress, timeout: Int) {
            val address = endpoint as InetSocketAddress
            super.connect(
              if (address.port == 443) InetSocketAddress(address.address, viewerPort) else address,
              timeout
            )
          }
        }

      override fun createSocket(): Socket = rewriting()

      override fun createSocket(host: String, port: Int): Socket = rewriting().also {
        it.connect(InetSocketAddress(host, port))
      }

      override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int) =
        createSocket(host, port)

      override fun createSocket(host: InetAddress, port: Int): Socket = rewriting().also {
        it.connect(InetSocketAddress(host, port))
      }

      override fun createSocket(
        address: InetAddress,
        port: Int,
        local: InetAddress,
        localPort: Int
      ) = createSocket(address, port)
    }
  )
