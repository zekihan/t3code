package expo.modules.t3clientcertificates.enroll

import android.content.SharedPreferences
import java.io.IOException
import org.json.JSONArray
import org.json.JSONException

/** Where the enrolled identity's state is kept. One atomic write per change. */
internal interface EnrollmentStorage {
  fun load(): EnrollmentState?

  /** Replaces the state; null clears it. Throws when the write did not reach storage. */
  fun save(state: EnrollmentState?)

  /** Viewer origins the Mesh screen last got from the hub; they use the enrolled identity. */
  fun meshOrigins(): Set<String>

  fun saveMeshOrigins(origins: Set<String>)
}

/** The fork's own preferences file, apart from the KeyChain aliases of `t3-client-certificates`. */
internal const val ENROLLMENT_PREFERENCES = "t3-mesh-enrollment"

private const val STATE_KEY = "state"
private const val ORIGINS_KEY = "mesh-origins"

internal class PreferencesEnrollmentStorage(private val preferences: SharedPreferences) :
  EnrollmentStorage {
  override fun load() = EnrollmentStateCodec.decode(preferences.getString(STATE_KEY, null))

  override fun save(state: EnrollmentState?) {
    val edit = preferences.edit()
    if (state ==
      null
    ) {
      edit.remove(STATE_KEY)
    } else {
      edit.putString(STATE_KEY, EnrollmentStateCodec.encode(state))
    }
    if (!edit.commit()) throw IOException("Could not save the enrollment state.")
  }

  override fun meshOrigins(): Set<String> =
    try {
      val array = JSONArray(preferences.getString(ORIGINS_KEY, "[]"))
      (0 until array.length()).map { array.getString(it) }.toSet()
    } catch (_: JSONException) {
      emptySet()
    }

  override fun saveMeshOrigins(origins: Set<String>) {
    val written = preferences.edit().putString(
      ORIGINS_KEY,
      JSONArray(origins.sorted()).toString()
    ).commit()
    if (!written) throw IOException("Could not save the mesh origins.")
  }
}
