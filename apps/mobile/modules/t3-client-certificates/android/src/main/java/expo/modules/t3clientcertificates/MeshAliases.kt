package expo.modules.t3clientcertificates

/**
 * Aliases the Mesh screen assigned to mesh viewer origins, next to the ones the person chose.
 * An origin's alias is the person's unless a marker for that origin records that the app
 * assigned it; a marker only counts while it still equals the stored alias. Choosing or
 * removing a certificate for an origin clears its marker, so a person's choice is never
 * overwritten or removed by a later sync, even when it names the same alias.
 */
internal const val MESH_MARKER_PREFIX = "mesh-assigned:"

internal fun meshMarker(origin: String) = MESH_MARKER_PREFIX + origin

/** What to write in one atomic preferences commit. `aliasChanged` means the origin's identity moved. */
internal class MeshAliasPlan(
  val puts: Map<String, String>,
  val removes: Set<String>,
  val aliasChanged: Boolean
)

private fun ownedByMesh(stored: Map<String, *>, origin: String): Boolean {
  val alias = stored[origin] as? String ?: return false
  return stored[meshMarker(origin)] == alias
}

/** Null when the origin has an alias of its own: the person's choice stays. */
internal fun planMeshAssign(stored: Map<String, *>, origin: String, alias: String): MeshAliasPlan? {
  val current = stored[origin] as? String
  if (current != null && !ownedByMesh(stored, origin)) return null
  return MeshAliasPlan(
    puts = mapOf(origin to alias, meshMarker(origin) to alias),
    removes = emptySet(),
    aliasChanged = current != alias
  )
}

/** Removes the alias only when the app assigned it; always drops a stale marker. */
internal fun planMeshRelease(stored: Map<String, *>, origin: String): MeshAliasPlan? {
  if (!stored.containsKey(meshMarker(origin))) return null
  val owned = ownedByMesh(stored, origin)
  return MeshAliasPlan(
    puts = emptyMap(),
    removes = if (owned) setOf(origin, meshMarker(origin)) else setOf(meshMarker(origin)),
    aliasChanged = owned
  )
}

internal fun meshAssignedOrigins(stored: Map<String, *>): List<String> =
  stored.keys.filter { it.startsWith(MESH_MARKER_PREFIX) }.map {
    it.removePrefix(MESH_MARKER_PREFIX)
  }

/** The hub's origin; its alias is the one the Mesh screen hands to viewer origins. */
internal const val MESH_HUB_ORIGIN = "https://hub.mesh.noqer.com/"

/**
 * Removing the hub's certificate takes back every alias the app handed out from it at once,
 * rather than at the next successful list fetch.
 */
internal fun planMeshReleaseAll(stored: Map<String, *>): Map<String, MeshAliasPlan> =
  meshAssignedOrigins(stored).mapNotNull { origin ->
    planMeshRelease(stored, origin)?.let { origin to it }
  }.toMap()
