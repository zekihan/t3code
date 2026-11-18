package expo.modules.t3clientcertificates.direct

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network

/**
 * Tells [onChange] when the phone's default network is replaced or lost. The first network seen is
 * the starting point, not a change. A Wi-Fi roam that keeps the same network is not a change.
 */
internal class DirectNetwork(private val onChange: () -> Unit) {
  private var current: Network? = null
  private var known = false

  private val callback =
    object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        val changed = synchronized(this@DirectNetwork) {
          val replaced = known && network != current
          current = network
          known = true
          replaced
        }
        if (changed) onChange()
      }

      override fun onLost(network: Network) {
        val changed = synchronized(this@DirectNetwork) {
          val lost = network == current
          if (lost) current = null
          lost
        }
        if (changed) onChange()
      }
    }

  // Without the callback the path just never re-probes early.
  @Suppress("TooGenericExceptionCaught")
  fun register(context: Context) {
    try {
      val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      manager.registerDefaultNetworkCallback(callback)
    } catch (_: SecurityException) {
      // No permission to watch the network: the 60 s failure cache still bounds the cost.
    } catch (_: RuntimeException) {
      // The system refused the registration (too many callbacks).
    }
  }
}
