package expo.modules.t3clientcertificates.direct

import expo.modules.t3clientcertificates.MESH_HUB_ORIGIN
import expo.modules.t3clientcertificates.enroll.parseCertificates
import java.io.IOException
import java.security.GeneralSecurityException
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

private val HEX_FINGERPRINT = Regex("^[0-9a-f]{64}$")
private const val MAX_REVISION = 256
private const val MAX_MACHINES = 256

/** What a fleet answer tells the direct path: where the phone is, and where machines listen. */
internal class FleetAnswer(val gate: HubGate, val routes: Map<String, DirectRoute>)

internal sealed interface HubReply<out T> {
  data class Ok<T>(val value: T) : HubReply<T>

  /** The hub did not answer with something usable; cached state stays as it is. */
  data class Failed(val detail: String) : HubReply<Nothing>
}

internal object HubParsing {
  /**
   * The gate and the routes in a `/api/v1/fleet` answer, or null when it is not a fleet. A machine's
   * route is kept only as the hub's own entry for that machine, with a LAN address literal and the
   * identity `agent-<machine>`; anything else makes that machine have no route.
   */
  fun fleet(body: String, now: Long): FleetAnswer? =
    try {
      val root = JSONObject(body)
      val machines = root.optJSONArray("machines")
      val path = root.optJSONObject("caller")?.optString("path")
      if (machines == null) {
        null
      } else {
        FleetAnswer(if (path == "LAN") HubGate.HOME else HubGate.AWAY, routesOf(machines, now))
      }
    } catch (_: JSONException) {
      null
    }

  // The first entry of a name decides it, even when that entry has no route.
  private fun routesOf(machines: JSONArray, now: Long): Map<String, DirectRoute> {
    val routes = mutableMapOf<String, DirectRoute>()
    val seen = mutableSetOf<String>()
    for (index in 0 until minOf(machines.length(), MAX_MACHINES)) {
      val entry = machines.optJSONObject(index) ?: continue
      val name = entry.optString("name")
      if (seen.add(name)) routeOf(name, entry, now)?.let { routes[name] = it }
    }
    return routes
  }

  private fun routeOf(name: String, entry: JSONObject, now: Long): DirectRoute? {
    val direct = entry.optJSONObject("direct")
    val own = isViewerEntry(name, entry.optString("viewerUrl"))
    return if (direct == null || !own) {
      null
    } else {
      acceptRoute(
        name,
        direct.optString("address"),
        direct.optInt("port", 0),
        entry.optString("agentIdentity"),
        now
      )
    }
  }

  private fun isViewerEntry(name: String, viewerUrl: String): Boolean {
    val host = viewerHost(name)
    return machineOfViewerHost(host) == name &&
      (viewerUrl == "https://$host" || viewerUrl == "https://$host/")
  }

  /** The trust in a `/api/v1/trust` answer, or null when anything in it is unusable. */
  fun trust(body: String, now: Long): DirectTrust? =
    try {
      val root = JSONObject(body)
      val bundle = root.getString("caBundle")
      val revision = root.getString("caRevision")
      val list = root.getJSONArray("revokedAgents")
      val revoked = (0 until list.length()).map { list.getString(it) }
      if (revision.isEmpty() || revision.length > MAX_REVISION) {
        null
      } else if (revoked.any { !HEX_FINGERPRINT.matches(it) } || !hasCertificates(bundle)) {
        null
      } else {
        DirectTrust(bundle, revision, revoked.toSet(), now)
      }
    } catch (_: JSONException) {
      null
    }

  private fun hasCertificates(pem: String) =
    try {
      parseCertificates(pem).isNotEmpty()
    } catch (_: GeneralSecurityException) {
      false
    }
}

/** The two hub requests of a hub contact. The client presents the device's mesh identity. */
internal class DirectHub(
  private val client: OkHttpClient,
  private val clock: () -> Long = System::currentTimeMillis,
  private val base: String = MESH_HUB_ORIGIN.trimEnd('/')
) {
  fun fleet(): HubReply<FleetAnswer> =
    get("/api/v1/fleet") { HubParsing.fleet(it, clock()) }

  fun trust(): HubReply<DirectTrust> =
    get("/api/v1/trust") { HubParsing.trust(it, clock()) }

  private fun <T> get(path: String, parse: (String) -> T?): HubReply<T> =
    try {
      val request = Request.Builder().url(base + path).header("Accept", "application/json").build()
      client.newCall(request).execute().use { answer(it, parse) }
    } catch (error: IOException) {
      HubReply.Failed(error.message ?: "The hub could not be reached.")
    }

  private fun <T> answer(response: Response, parse: (String) -> T?): HubReply<T> {
    if (!response.isSuccessful) return HubReply.Failed("The hub answered HTTP ${response.code}.")
    val value = parse(response.peekBody(MAX_BODY).string())
    return if (value !=
      null
    ) {
      HubReply.Ok(value)
    } else {
      HubReply.Failed("The hub's answer was unusable.")
    }
  }

  private companion object {
    const val MAX_BODY = 512L * 1024
  }
}
