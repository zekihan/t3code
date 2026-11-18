package expo.modules.t3clientcertificates.localnet

import java.io.IOException
import java.net.ConnectException
import java.net.InetAddress
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import okhttp3.Dns
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalNetworkAccessTest {
  private fun state(sdk: Int, target: Int, granted: Boolean) =
    localNetworkState(sdk, target) { granted }

  @Test fun theGrantOnlyMattersOnAndroid17ForAnAppThatTargets37() {
    assertEquals(LocalNetworkState.DENIED, state(37, 37, false))
    assertEquals(LocalNetworkState.GRANTED, state(37, 37, true))
    assertEquals(LocalNetworkState.DENIED, state(38, 40, false))
  }

  @Test fun belowAndroid17OrBelowTarget37TheAccessIsImplicit() {
    assertEquals(LocalNetworkState.NOT_REQUIRED, state(37, 36, false))
    assertEquals(LocalNetworkState.NOT_REQUIRED, state(36, 37, false))
    assertEquals(LocalNetworkState.NOT_REQUIRED, state(35, 35, false))
  }

  @Test fun theGrantIsNotReadWhereItIsNotRequired() {
    var read = 0
    localNetworkState(36, 36) { read++ > 0 }
    localNetworkState(37, 36) { read++ > 0 }
    assertEquals(0, read)
  }

  @Test fun onlyADeniedStateBlocksLanConnections() {
    assertFalse(LocalNetworkState.DENIED.allowsLan)
    assertTrue(LocalNetworkState.GRANTED.allowsLan)
    assertTrue(LocalNetworkState.NOT_REQUIRED.allowsLan)
  }

  @Test fun thePermissionIsTheOneAndroid17Names() {
    assertEquals("android.permission.ACCESS_LOCAL_NETWORK", LOCAL_NETWORK_PERMISSION)
  }

  private fun ip(text: String) = InetAddress.getByName(text)

  @Test fun privateLinkLocalAndCgnatAddressesMayBeLocalNetwork() {
    listOf(
      "10.0.2.2", "172.16.0.1", "172.31.255.1", "192.168.2.81", "169.254.1.1", "100.64.0.1",
      "100.127.1.1", "fd12:3456:789a:1::81", "fc00::1", "fe80::1"
    ).forEach {
      assertTrue(it, mayBeLocalNetwork(ip(it)))
    }
  }

  @Test fun publicLoopbackAndMulticastAddressesAreNot() {
    listOf(
      "8.8.8.8", "172.32.0.1", "172.15.0.1", "100.128.0.1", "127.0.0.1", "::1", "224.0.0.251",
      "2606:4700::1111", "ff02::fb"
    ).forEach {
      assertFalse(it, mayBeLocalNetwork(ip(it)))
    }
  }

  @Test fun theShapesOfADroppedConnection() {
    assertTrue(looksLikeDroppedConnection(SocketTimeoutException("connect timed out")))
    assertTrue(looksLikeDroppedConnection(ConnectException("failed to connect")))
    assertTrue(
      looksLikeDroppedConnection(SocketException("sendto failed: EPERM (Operation not permitted)"))
    )
    assertFalse(looksLikeDroppedConnection(SocketException("Connection reset")))
    assertFalse(looksLikeDroppedConnection(IOException("unexpected end of stream")))
  }

  private class Fixed(private val states: () -> LocalNetworkState) : LocalNetworkGate {
    override fun state() = states()
  }

  private fun interceptor(
    state: LocalNetworkState,
    resolved: List<String>? = listOf("192.168.2.81")
  ) =
    LocalNetworkErrorInterceptor(
      Fixed { state },
      object : Dns {
        override fun lookup(hostname: String): List<InetAddress> =
          resolved?.map { InetAddress.getByName(it) } ?: throw UnknownHostException(hostname)
      }
    )

  @Test fun aTimeoutToALanAddressWithoutThePermissionSaysSo() {
    val timeout = SocketTimeoutException("connect timed out")
    val mapped = interceptor(
      LocalNetworkState.DENIED
    ).mapped(timeout, "t3.z-arch.mesh.noqer.com", false)
    assertTrue(mapped is LocalNetworkDeniedException)
    assertSame(timeout, mapped.cause)
    assertTrue(mapped.message.orEmpty().startsWith(LOCAL_NETWORK_DENIED_MESSAGE))
    assertTrue(mapped.message.orEmpty().contains("t3.z-arch.mesh.noqer.com"))
  }

  @Test fun aLiteralLanAddressWorksTheSameWay() {
    val mapped =
      interceptor(LocalNetworkState.DENIED, resolved = listOf("10.0.2.2"))
        .mapped(ConnectException("failed"), "10.0.2.2", false)
    assertTrue(mapped is LocalNetworkDeniedException)
  }

  @Test fun withThePermissionOrWhereItIsNotRequiredTheErrorStaysAsItWas() {
    val timeout = SocketTimeoutException("connect timed out")
    assertSame(
      timeout,
      interceptor(LocalNetworkState.GRANTED).mapped(timeout, "t3.example.lan", false)
    )
    assertSame(
      timeout,
      interceptor(LocalNetworkState.NOT_REQUIRED).mapped(timeout, "t3.example.lan", false)
    )
  }

  @Test fun aHostOutsideTheLocalNetworkKeepsItsTimeout() {
    val timeout = SocketTimeoutException("connect timed out")
    assertSame(
      timeout,
      interceptor(LocalNetworkState.DENIED, resolved = listOf("203.0.113.9"))
        .mapped(timeout, "example.com", false)
    )
    assertSame(
      timeout,
      interceptor(LocalNetworkState.DENIED, resolved = null).mapped(timeout, "nope.invalid", false)
    )
  }

  @Test fun aCanceledCallAndAnUnrelatedFailureAreLeftAlone() {
    val timeout = SocketTimeoutException("timeout")
    assertSame(timeout, interceptor(LocalNetworkState.DENIED).mapped(timeout, "192.168.2.81", true))
    val reset = IOException("unexpected end of stream")
    assertSame(reset, interceptor(LocalNetworkState.DENIED).mapped(reset, "192.168.2.81", false))
  }

  @Test fun anAlreadyMappedErrorIsNotWrappedTwice() {
    val first = LocalNetworkDeniedException("192.168.2.81", SocketTimeoutException("t"))
    assertSame(first, interceptor(LocalNetworkState.DENIED).mapped(first, "192.168.2.81", false))
  }
}
