package expo.modules.t3clientcertificates.direct

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.t3clientcertificates.T3CertificateTransport
import java.net.URI

/**
 * What the Mesh screen reads about the direct connection at home (A8): which path an environment
 * takes and why, and whether the machine's certificate or authorization failed. The path itself is
 * decided natively by [DirectPaths]; the screen only asks.
 */
class T3MeshDirectModule : Module() {
  private lateinit var transport: T3CertificateTransport

  override fun definition() = ModuleDefinition {
    Name("T3MeshDirect")
    Events("directChanged")
    OnCreate {
      val context = requireNotNull(appContext.reactContext).applicationContext
      transport = T3CertificateTransport.install(context)
      transport.direct.changed = { machine ->
        sendEvent(
          "directChanged",
          mapOf("machine" to machine, "origin" to "https://${viewerHost(machine)}")
        )
      }
    }
    OnDestroy {
      if (::transport.isInitialized) transport.direct.changed = null
    }
    OnActivityEntersForeground {
      if (::transport.isInitialized) transport.direct.paths.refreshHub(force = false)
    }
    // The hub was just contacted by the app (machines or fleet): refresh trust and routes too.
    Function("hubContacted") {
      if (::transport.isInitialized) transport.direct.paths.refreshHub(force = false)
    }
    AsyncFunction("getStatus") { url: String -> statusOf(url) }
  }

  private fun statusOf(url: String): Map<String, Any?>? {
    val machine =
      try {
        machineOfViewerHost(URI(url).host)
      } catch (_: java.net.URISyntaxException) {
        null
      } ?: return null
    return transport.direct.paths.status(machine).toMap()
  }
}

private fun DirectFailure.toMap() =
  mapOf("kind" to kind.code, "detail" to detail, "at" to at)

internal fun DirectStatus.toMap(): Map<String, Any?> =
  mapOf(
    "path" to if (direct) "direct" else "viewer",
    "network" to if (direct) "LAN" else null,
    "reason" to reason?.code,
    "identity" to identity?.wire,
    "failure" to failure?.toMap(),
    "unreachable" to unreachable?.toMap(),
    "unknownOutcome" to
      unknownOutcomeAt?.let { mapOf("at" to it, "method" to unknownOutcomeMethod) },
    "probing" to probing,
    "trustFetchedAt" to trustFetchedAt,
    "routeSavedAt" to routeSavedAt
  )
