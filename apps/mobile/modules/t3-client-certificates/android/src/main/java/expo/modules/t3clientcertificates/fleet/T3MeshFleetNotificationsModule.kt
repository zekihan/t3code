package expo.modules.t3clientcertificates.fleet

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.t3clientcertificates.T3CertificateTransport

class T3MeshFleetNotificationsModule : Module() {
  private val notifications: FleetNotifications
    get() {
      val context = requireNotNull(appContext.reactContext)
      return T3CertificateTransport.install(context).fleetNotifications
    }

  override fun definition() = ModuleDefinition {
    Name("T3MeshFleetNotifications")
    Function("isEnabled") { notifications.isEnabled() }
    AsyncFunction("setEnabled") { enabled: Boolean -> notifications.setEnabled(enabled) }
  }
}
