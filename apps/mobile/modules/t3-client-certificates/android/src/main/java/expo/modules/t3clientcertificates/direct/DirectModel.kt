package expo.modules.t3clientcertificates.direct

import java.net.InetAddress
import org.json.JSONException
import org.json.JSONObject

internal const val DAY_MS = 24L * 60 * 60 * 1000

/** The cached trust and each cached route work for the agents' cache window: one week. */
internal const val DIRECT_CACHE_MS = 7 * DAY_MS

/** A failed probe keeps the phone on the viewer host for this long, as agents do for a failed dial. */
internal const val PROBE_FAILURE_CACHE_MS = 60_000L

/** Answered by the agent itself, with no effect on T3. */
internal const val DIRECT_PROBE_PATH = "/.well-known/t3-mesh/direct"

internal const val VIEWER_PORT = 443
private const val MESH_DOMAIN = "mesh.noqer.com"
internal const val AGENT_IDENTITY_PREFIX = "agent-"
internal const val AGENT_URI_PREFIX = "urn:noqer:mtls:clients:"

private val VIEWER_HOST =
  Regex("^t3\\.([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)\\.mesh\\.noqer\\.com$")
private val IPV4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")
private val IPV6_CHARS = Regex("^[0-9a-fA-F:]{2,45}$")
private const val IPV4_OCTETS = 4
private const val MAX_OCTET = 255
private const val MAX_PORT = 65_535

internal fun viewerHost(machine: String) = "t3.$machine.$MESH_DOMAIN"

/** The machine a mesh viewer host belongs to, or null for any other host. */
internal fun machineOfViewerHost(host: String?): String? =
  host?.let { VIEWER_HOST.matchEntire(it)?.groupValues?.get(1) }

internal fun agentIdentityOf(machine: String) = AGENT_IDENTITY_PREFIX + machine

internal fun agentUriOf(identity: String) = AGENT_URI_PREFIX + identity

/**
 * A private LAN address given as an IP literal, or null. Names are never resolved, and a public,
 * loopback, link-local IPv6 (it needs a scope) or multicast address is not a home machine.
 */
internal fun parseLanAddress(text: String): InetAddress? {
  val bytes =
    when {
      IPV4.matches(text) -> ipv4Bytes(text)
      IPV6_CHARS.matches(text) && text.contains(':') -> ipv6Bytes(text)
      else -> null
    } ?: return null
  return if (isLanAddress(bytes)) InetAddress.getByAddress(bytes) else null
}

private fun ipv4Bytes(text: String): ByteArray? {
  val parts = text.split('.')
  if (parts.size != IPV4_OCTETS || parts.any { it.length > 1 && it.startsWith('0') }) return null
  val octets = parts.map { it.toInt() }
  return if (octets.any { it > MAX_OCTET }) null else ByteArray(IPV4_OCTETS) { octets[it].toByte() }
}

// The literal has only hex digits and colons, so no name lookup can happen here.
private fun ipv6Bytes(text: String): ByteArray? =
  try {
    InetAddress.getByName(text).address.takeIf { it.size == 16 }
  } catch (_: java.net.UnknownHostException) {
    null
  }

private fun isLanAddress(bytes: ByteArray): Boolean {
  val first = bytes[0].toInt() and 0xFF
  val second = bytes[1].toInt() and 0xFF
  return if (bytes.size == IPV4_OCTETS) {
    first == 10 ||
      (first == 172 && second in 16..31) ||
      (first == 192 && second == 168) ||
      (first == 169 && second == 254)
  } else {
    first and 0xFE == 0xFC
  }
}

/** Where a machine's agent listens while it is home, as the hub reported it. */
internal data class DirectRoute(
  val machine: String,
  val address: String,
  val port: Int,
  val agentIdentity: String,
  /** When the hub last reported this route (epoch ms); it works for a week from then. */
  val savedAt: Long
) {
  /** The route without its time: a changed place or identity invalidates what was probed. */
  val place get() = "$address:$port/$agentIdentity"

  fun expired(now: Long) = now - savedAt >= DIRECT_CACHE_MS || savedAt > now + DAY_MS
}

/** Accepts a hub route only for its own machine: a LAN literal, a port and `agent-<machine>`. */
internal fun acceptRoute(
  machine: String,
  address: String?,
  port: Int?,
  agentIdentity: String?,
  now: Long
): DirectRoute? =
  if (address == null || port == null || port !in 1..MAX_PORT) {
    null
  } else if (agentIdentity != agentIdentityOf(machine) || parseLanAddress(address) == null) {
    null
  } else {
    DirectRoute(machine, address, port, agentIdentity, now)
  }

/** The clients CA bundle with the agent revocations, as of [fetchedAt]. */
internal data class DirectTrust(
  val caBundlePem: String,
  val caRevision: String,
  /** Lowercase hex SHA-256 fingerprints of blocked leaves. */
  val revoked: Set<String>,
  val fetchedAt: Long
) {
  fun expired(now: Long) = now - fetchedAt >= DIRECT_CACHE_MS || fetchedAt > now + DAY_MS
}

internal data class DirectSnapshot(val trust: DirectTrust?, val routes: Map<String, DirectRoute>)

/** The state kept between runs, so a cold start without the hub can still go direct. */
internal object DirectSnapshotCodec {
  private const val VERSION = 1

  fun encode(snapshot: DirectSnapshot): String =
    JSONObject()
      .put("v", VERSION)
      .apply {
        snapshot.trust?.let { trust ->
          put(
            "trust",
            JSONObject()
              .put("caBundle", trust.caBundlePem)
              .put("caRevision", trust.caRevision)
              .put("revoked", org.json.JSONArray(trust.revoked.sorted()))
              .put("fetchedAt", trust.fetchedAt)
          )
        }
        val routes = JSONObject()
        snapshot.routes.values.sortedBy { it.machine }.forEach { route ->
          routes.put(
            route.machine,
            JSONObject()
              .put("address", route.address)
              .put("port", route.port)
              .put("identity", route.agentIdentity)
              .put("savedAt", route.savedAt)
          )
        }
        put("routes", routes)
      }
      .toString()

  /** An empty snapshot for anything that is not a state this version wrote. */
  fun decode(json: String?): DirectSnapshot {
    if (json.isNullOrEmpty()) return DirectSnapshot(null, emptyMap())
    return try {
      parse(JSONObject(json))
    } catch (_: JSONException) {
      DirectSnapshot(null, emptyMap())
    }
  }

  private fun parse(root: JSONObject): DirectSnapshot {
    if (root.getInt("v") != VERSION) return DirectSnapshot(null, emptyMap())
    val trust =
      root.optJSONObject("trust")?.let {
        val revoked = it.getJSONArray("revoked")
        DirectTrust(
          caBundlePem = it.getString("caBundle"),
          caRevision = it.getString("caRevision"),
          revoked = (0 until revoked.length()).map { index -> revoked.getString(index) }.toSet(),
          fetchedAt = it.getLong("fetchedAt")
        )
      }
    val routes = mutableMapOf<String, DirectRoute>()
    val stored = root.optJSONObject("routes")
    stored?.keys()?.forEach { machine ->
      val route = stored.getJSONObject(machine)
      // A stored route is checked again like a hub's: the file is not a source of authority.
      acceptRoute(
        machine,
        route.getString("address"),
        route.getInt("port"),
        route.getString("identity"),
        route.getLong("savedAt")
      )?.let { routes[machine] = it }
    }
    return DirectSnapshot(trust, routes)
  }
}

internal interface DirectStore {
  fun load(): DirectSnapshot

  fun save(snapshot: DirectSnapshot)
}

internal class PreferencesDirectStore(private val preferences: android.content.SharedPreferences) :
  DirectStore {
  override fun load() = DirectSnapshotCodec.decode(preferences.getString(KEY, null))

  override fun save(snapshot: DirectSnapshot) {
    preferences.edit().putString(KEY, DirectSnapshotCodec.encode(snapshot)).apply()
  }

  private companion object {
    const val KEY = "snapshot"
  }
}

/** The preferences file of the direct path, apart from the aliases and the enrollment. */
internal const val DIRECT_PREFERENCES = "t3-mesh-direct"
