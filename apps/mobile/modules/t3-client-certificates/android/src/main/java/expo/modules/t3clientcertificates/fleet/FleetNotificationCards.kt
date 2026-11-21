package expo.modules.t3clientcertificates.fleet

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import expo.modules.t3clientcertificates.R

internal class FleetNotificationCards(private val context: Context) {
  private val manager = context.getSystemService(NotificationManager::class.java)

  fun createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(
          CHANNEL,
          context.getString(R.string.t3_mesh_fleet_channel),
          NotificationManager.IMPORTANCE_DEFAULT
        )
      )
    }
  }

  fun post(changes: FleetChanges) {
    if (changes.down.isNotEmpty()) {
      post("down", R.string.t3_mesh_fleet_down, machineNames(changes.down))
    }
    if (changes.back.isNotEmpty()) {
      post("back", R.string.t3_mesh_fleet_back, machineNames(changes.back))
    }
    if (changes.alerts.isNotEmpty()) {
      post("alerts", R.string.t3_mesh_fleet_alerts, machineNames(changes.alerts))
    }
    changes.enrollment?.let {
      val body = when (it) {
        EnrollmentNotice.REENROLL -> R.string.t3_mesh_fleet_reenroll
        EnrollmentNotice.RENEWAL_FAILED -> R.string.t3_mesh_fleet_renewal_failed
      }
      post("device", R.string.t3_mesh_fleet_device, context.getString(body))
    }
  }

  fun clear() {
    listOf("down", "back", "alerts", "device").forEach { manager.cancel(tag(it), 0) }
  }

  @SuppressLint("MissingPermission") // The OS permission can change between the check and the post.
  private fun post(category: String, title: Int, body: String) {
    if (!manager.areNotificationsEnabled()) return
    val openMesh = contentIntent() ?: return
    val notification = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.t3_mesh_fleet_notification)
      .setContentTitle(context.getString(title))
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setContentIntent(openMesh)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setAutoCancel(true)
      .build()
    try {
      manager.notify(tag(category), 0, notification)
    } catch (_: SecurityException) {
      // Permission was revoked while the poll was finishing.
    }
  }

  private fun contentIntent(): PendingIntent? {
    val url = context.packageManager
      .getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
      .metaData?.getString("expo.modules.t3clientcertificates.FLEET_LAUNCH_URL")
    val launch =
      context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    return url?.let {
      launch.setAction(Intent.ACTION_VIEW).setData(Uri.parse(it))
        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      PendingIntent.getActivity(
        context,
        0,
        launch,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }
  }

  private fun machineNames(names: List<String>): String =
    names.take(MAX_NAMES).joinToString(", ") + if (names.size > MAX_NAMES) ", …" else ""

  private fun tag(category: String) = "$CHANNEL:$category"

  private companion object {
    const val CHANNEL = "t3-mesh-fleet"
    const val MAX_NAMES = 5
  }
}
