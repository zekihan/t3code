package expo.modules.t3clientcertificates.localnet

import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.t3clientcertificates.T3CertificateTransport

/**
 * Android 17's local network permission, for the screens: whether it is held, and the system
 * prompt. The platform enforces it per UID, so the loopback proxy, the `:stream` process and the
 * WebViews all follow this one state. [expo.modules.t3clientcertificates.direct.DirectPaths] reads
 * it too: no grant, no direct attempt.
 */
class T3MeshLocalNetworkModule : Module() {
  private lateinit var transport: T3CertificateTransport

  override fun definition() = ModuleDefinition {
    Name("T3MeshLocalNetwork")
    OnCreate {
      val context = requireNotNull(appContext.reactContext).applicationContext
      transport = T3CertificateTransport.install(context)
    }
    // A grant made in Settings while the app was in the background shows up here.
    OnActivityEntersForeground {
      if (::transport.isInitialized) transport.direct.paths.refreshLocalNetwork()
    }
    AsyncFunction("getState") { transport.direct.localNetwork.state().code }
    AsyncFunction("request") { promise: Promise ->
      val state = transport.direct.localNetwork.state()
      if (state != LocalNetworkState.DENIED) {
        promise.resolve(mapOf("state" to state.code, "canAskAgain" to false))
        return@AsyncFunction
      }
      val permissions = appContext.permissions ?: throw Exceptions.PermissionsModuleNotFound()
      permissions.askForPermissions({ result ->
        val response = result[LOCAL_NETWORK_PERMISSION]
        transport.direct.paths.refreshLocalNetwork()
        promise.resolve(
          mapOf(
            "state" to transport.direct.localNetwork.state().code,
            "canAskAgain" to (response?.canAskAgain ?: false)
          )
        )
      }, LOCAL_NETWORK_PERMISSION)
    }
  }
}
