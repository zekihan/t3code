package expo.modules.t3clientcertificates.fleet

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

private val MACHINE_NAME = Regex("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")

internal fun parseFleet(body: String): Map<String, FleetMachine>? =
  try {
    val machines = JSONObject(body).getJSONArray("machines")
    buildMap {
      for (index in 0 until machines.length()) {
        val entry = machines.getJSONObject(index)
        val name = entry.getString("name")
        val online = entry.get("online") as? Boolean ?: return null
        val t3 = entry.optJSONObject("services")?.optJSONObject("t3")
        val health = when (t3?.optString("state")) {
          null -> T3Health.ABSENT
          "reachable" -> T3Health.REACHABLE
          "unreachable" -> T3Health.UNREACHABLE
          else -> T3Health.UNKNOWN
        }
        if (!MACHINE_NAME.matches(name) || containsKey(name)) return null
        put(name, FleetMachine(online, health, entry.getJSONArray("alerts").strings()))
      }
    }
  } catch (_: JSONException) {
    null
  }

private fun JSONArray.strings() = (0 until length()).map(::getString).toSet()

internal object FleetSnapshotCodec {
  private const val VERSION = 1

  fun encode(snapshot: FleetSnapshot): String =
    JSONObject().put("v", VERSION).apply {
      snapshot.machines?.let { machines ->
        put(
          "machines",
          JSONObject().apply {
            machines.forEach { (name, machine) ->
              put(
                name,
                JSONObject()
                  .put("online", machine.online)
                  .put("t3", machine.t3.name)
                  .put("alerts", JSONArray(machine.alerts.toList()))
                  .put("unavailable", machine.unavailable)
              )
            }
          }
        )
      }
      snapshot.enrollment?.let { enrollment ->
        put(
          "enrollment",
          JSONObject()
            .put("issuedAt", enrollment.issuedAt)
            .put("needsReenrollment", enrollment.needsReenrollment)
            .put("renewalFailed", enrollment.renewalFailed)
            .put("hubRefused", enrollment.hubRefused)
        )
      }
    }.toString()

  fun decode(value: String?): FleetSnapshot? =
    try {
      value?.let { parseSnapshot(JSONObject(it)) }
    } catch (_: JSONException) {
      null
    } catch (_: IllegalArgumentException) {
      null
    }

  private fun parseSnapshot(root: JSONObject): FleetSnapshot? {
    if (root.getInt("v") != VERSION) return null
    return FleetSnapshot(
      root.optJSONObject("machines")?.let { machines ->
        machines.keys().asSequence().associateWith { name ->
          val machine = machines.getJSONObject(name)
          FleetMachine(
            machine.getBoolean("online"),
            T3Health.valueOf(machine.getString("t3")),
            machine.getJSONArray("alerts").strings(),
            machine.getBoolean("unavailable")
          )
        }
      },
      root.optJSONObject("enrollment")?.let {
        FleetEnrollment(
          it.getLong("issuedAt"),
          it.getBoolean("needsReenrollment"),
          it.getBoolean("renewalFailed"),
          it.getBoolean("hubRefused")
        )
      }
    )
  }
}
