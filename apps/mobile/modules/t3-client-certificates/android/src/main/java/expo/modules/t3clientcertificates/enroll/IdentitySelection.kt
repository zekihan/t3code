package expo.modules.t3clientcertificates.enroll

import expo.modules.t3clientcertificates.MESH_HUB_ORIGIN
import expo.modules.t3clientcertificates.certificateOrigin

/** Stands in for a KeyChain alias where the app reports which identity an origin uses. */
internal const val ENROLLED_ALIAS_PREFIX = "enrolled:"

internal fun enrolledAlias(identity: String) = ENROLLED_ALIAS_PREFIX + identity

internal fun isEnrolledAlias(alias: String?) = alias?.startsWith(ENROLLED_ALIAS_PREFIX) == true

// The same shape the JS side accepts for a listed machine (`meshViewerOrigin`), as an origin.
private val VIEWER_ORIGIN =
  Regex("^https://t3\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.mesh\\.noqer\\.com/$")

internal fun isMeshViewerOrigin(origin: String) = VIEWER_ORIGIN.matches(origin)

/** Keeps only exact `https://t3.<machine>.mesh.noqer.com/` origins; the hub's list is not trusted. */
internal fun sanitizeMeshOrigins(origins: Collection<String>): Set<String> =
  origins.mapNotNull(::certificateOrigin).filter(::isMeshViewerOrigin).toSet()

/**
 * Whether [origin] is a mesh origin: the hub, or a viewer host the Mesh screen got from the hub
 * ([listed]) or assigned an alias to earlier ([marked]). Every other host, including mesh-domain
 * hosts the hub did not list, keeps its own KeyChain choice.
 */
internal fun isMeshOrigin(origin: String, listed: Set<String>, marked: (String) -> Boolean) =
  origin == MESH_HUB_ORIGIN || (isMeshViewerOrigin(origin) && (origin in listed || marked(origin)))

internal sealed interface IdentityChoice {
  /** No client certificate. */
  data object Anonymous : IdentityChoice

  data class KeyChain(val alias: String) : IdentityChoice

  /** The enrolled Keystore identity, with no fallback to KeyChain if it cannot be used. */
  data object Enrolled : IdentityChoice
}

/**
 * The identity for one origin. Once the device is enrolled, a mesh origin takes the enrolled
 * identity and the KeyChain alias stored for it is never read; other origins keep their alias.
 */
internal fun chooseIdentity(
  enrolled: Boolean,
  meshOrigin: Boolean,
  keyChainAlias: () -> String?
): IdentityChoice =
  when {
    enrolled && meshOrigin -> IdentityChoice.Enrolled
    else -> keyChainAlias()?.let { IdentityChoice.KeyChain(it) } ?: IdentityChoice.Anonymous
  }

/**
 * Picks the socket factory for an origin: the enrolled identity for a mesh origin once the device
 * is enrolled, otherwise what the person chose in KeyChain. The loaders are only called for the
 * source that was chosen, so an enrolled mesh origin never reaches KeyChain.
 */
internal class OriginIdentities<F>(
  private val enrolled: () -> Boolean,
  private val meshOrigin: (String) -> Boolean,
  private val keyChainAlias: (String) -> String?,
  private val fromEnrolled: (String) -> F,
  private val fromKeyChain: (origin: String, alias: String) -> F,
  private val anonymous: () -> F
) {
  fun factory(origin: String): F =
    when (val choice = chooseIdentity(enrolled(), meshOrigin(origin)) { keyChainAlias(origin) }) {
      IdentityChoice.Enrolled -> fromEnrolled(origin)
      IdentityChoice.Anonymous -> anonymous()
      is IdentityChoice.KeyChain -> fromKeyChain(origin, choice.alias)
    }
}
