package expo.modules.t3clientcertificates.localnet

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

/** The runtime permission Android 17 gates local network traffic behind (group NEARBY_DEVICES). */
internal const val LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"

/** The first API level that has the permission, and the first target level that is held to it. */
internal const val LOCAL_NETWORK_SDK = 37

/**
 * Whether this app may reach local network addresses. Below Android 17, or for an app that targets
 * less than 37, the platform grants the access implicitly with INTERNET, so nothing is asked.
 */
internal enum class LocalNetworkState(val code: String) {
  NOT_REQUIRED("not-required"),
  GRANTED("granted"),
  DENIED("denied");

  /** Whether a connection to a LAN address can work. */
  val allowsLan get() = this != DENIED
}

internal fun localNetworkState(
  sdkInt: Int,
  targetSdk: Int,
  granted: () -> Boolean
): LocalNetworkState =
  when {
    sdkInt < LOCAL_NETWORK_SDK || targetSdk < LOCAL_NETWORK_SDK -> LocalNetworkState.NOT_REQUIRED
    granted() -> LocalNetworkState.GRANTED
    else -> LocalNetworkState.DENIED
  }

/** Reads the permission state; the permission is per UID, so the `:stream` process shares it. */
internal fun interface LocalNetworkGate {
  fun state(): LocalNetworkState
}

internal class AndroidLocalNetworkGate(private val context: Context) : LocalNetworkGate {
  override fun state() =
    localNetworkState(
      Build.VERSION.SDK_INT,
      context.applicationInfo.targetSdkVersion
    ) {
      context.checkSelfPermission(LOCAL_NETWORK_PERMISSION) == PackageManager.PERMISSION_GRANTED
    }
}
