package expo.modules.t3clientcertificates.localnet

import java.io.IOException
import java.net.ConnectException
import java.net.InetAddress
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import okhttp3.Dns
import okhttp3.Interceptor
import okhttp3.Response

internal const val LOCAL_NETWORK_DENIED_MESSAGE =
  "Local network access denied. Allow Nearby devices for this app in Settings."

/** A connection to a local network address that Android dropped because the permission is missing. */
internal class LocalNetworkDeniedException(val host: String, cause: Throwable) :
  IOException("$LOCAL_NETWORK_DENIED_MESSAGE ($host)", cause)

/**
 * Whether Android 17's local network protection can apply to [address]: the private and link-local
 * IPv4 ranges (RFC 1918, 169.254/16, 100.64/10) and IPv6 unique-local and link-local addresses.
 * The platform decides by the interface's own on-link prefixes (an on-link global IPv6 prefix
 * counts too), which this cannot see; it is only used to word an error that already happened.
 */
internal fun mayBeLocalNetwork(address: InetAddress): Boolean {
  if (address.isLoopbackAddress || address.isAnyLocalAddress || address.isMulticastAddress) {
    return false
  }
  val bytes = address.address
  val first = bytes[0].toInt() and 0xFF
  val second = bytes[1].toInt() and 0xFF
  return if (bytes.size == IPV4_BYTES) isLocalIpv4(first, second) else isLocalIpv6(first, second)
}

private fun isLocalIpv4(first: Int, second: Int) =
  first == 10 ||
    (first == 172 && second in 16..31) ||
    (first == 192 && second == 168) ||
    (first == 169 && second == 254) ||
    (first == 100 && second in 64..127)

// Unique local fc00::/7 and link local fe80::/10.
private fun isLocalIpv6(first: Int, second: Int) =
  (first and 0xFE == 0xFC) || (first == 0xFE && (second and 0xC0) == 0x80)

/** The shapes a connect that Android drops takes: a timeout for TCP, EPERM for the rest. */
internal fun looksLikeDroppedConnection(error: IOException) =
  error is SocketTimeoutException ||
    error is ConnectException ||
    (error is SocketException && error.message.orEmpty().contains("EPERM", ignoreCase = true))

/**
 * Words a failed connection to a LAN address as the missing permission instead of a bare timeout.
 * Only a connect-shaped failure to an address that may be local counts, and only while the
 * permission is not granted; anything else passes through unchanged.
 */
internal class LocalNetworkErrorInterceptor(
  private val gate: LocalNetworkGate,
  private val lookup: Dns = Dns.SYSTEM
) : Interceptor {
  override fun intercept(chain: Interceptor.Chain): Response =
    try {
      chain.proceed(chain.request())
    } catch (error: IOException) {
      throw mapped(error, chain.request().url.host, chain.call().isCanceled())
    }

  internal fun mapped(error: IOException, host: String, canceled: Boolean): IOException =
    if (deniedLanFailure(error, host, canceled)) LocalNetworkDeniedException(host, error) else error

  private fun deniedLanFailure(error: IOException, host: String, canceled: Boolean): Boolean {
    val dropped =
      !canceled && error !is LocalNetworkDeniedException && looksLikeDroppedConnection(error)
    return dropped && gate.state() == LocalNetworkState.DENIED && resolvesToLocalNetwork(host)
  }

  // Runs only after a failure, and DNS to a local resolver on port 53 is exempt from the protection.
  private fun resolvesToLocalNetwork(host: String): Boolean =
    try {
      lookup.lookup(host).any(::mayBeLocalNetwork)
    } catch (_: UnknownHostException) {
      false
    }
}

private const val IPV4_BYTES = 4
