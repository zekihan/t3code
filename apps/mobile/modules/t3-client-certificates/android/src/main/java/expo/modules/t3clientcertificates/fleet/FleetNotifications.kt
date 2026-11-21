package expo.modules.t3clientcertificates.fleet

import android.app.NotificationManager
import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import android.util.AtomicFile
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

internal class FleetNotifications(
  private val context: Context,
  private val hasHubIdentity: () -> Boolean
) {
  private val prefs = context.getSharedPreferences(
    "t3-mesh-fleet-notifications",
    Context.MODE_PRIVATE
  )
  private val snapshot = AtomicFile(File(context.noBackupFilesDir, "mesh-fleet-snapshot.json"))
  private val alerts = FleetNotificationCards(context)
  private val manager = context.getSystemService(NotificationManager::class.java)
  private var session = Any()

  fun isEnabled(): Boolean =
    prefs.getBoolean("enabled", true) && hasHubIdentity() && manager.areNotificationsEnabled()

  @Synchronized
  fun reconcile() {
    val work = WorkManager.getInstance(context)
    if (isEnabled()) {
      alerts.createChannel()
      val request =
        PeriodicWorkRequest.Builder(FleetPollWorker::class.java, INTERVAL_MINUTES, TimeUnit.MINUTES)
          .setConstraints(
            Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
          )
          .build()
      work.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
    } else {
      session = Any()
      work.cancelUniqueWork(WORK_NAME)
    }
  }

  @Synchronized
  fun setEnabled(enabled: Boolean): Boolean {
    val edit = prefs.edit().putBoolean("enabled", enabled)
    if (!enabled) snapshot.delete()
    check(edit.commit())
    reconcile()
    if (!enabled) alerts.clear()
    return isEnabled()
  }

  @Synchronized
  fun currentSession(): Any? = session.takeIf { isEnabled() }

  @Synchronized
  fun reservePoll(expected: Any): Boolean {
    val boot = Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
    val elapsed = SystemClock.elapsedRealtime()
    val now = System.currentTimeMillis()
    if (currentSession() !== expected || !pollDue(boot, elapsed, now)) return false
    return prefs.edit()
      .putInt("lastPollBoot", boot)
      .putLong("lastPollElapsed", elapsed)
      .putLong("lastPollWall", now)
      .commit()
  }

  private fun pollDue(boot: Int, elapsed: Long, now: Long): Boolean {
    val previous = prefs.getLong("lastPollElapsed", -1)
    if (previous < 0) return true
    val previousWall = prefs.getLong("lastPollWall", 0)
    val age = if (boot >= 0 && boot == prefs.getInt("lastPollBoot", -1)) {
      elapsed - previous
    } else {
      if (now >= previousWall) now - previousWall else elapsed
    }
    // Keep the rate limit across cancellation, process loss, and quick off/on cycles.
    return age >= TimeUnit.MINUTES.toMillis(INTERVAL_MINUTES)
  }

  @Synchronized
  fun finish(
    expected: Any,
    fleet: Map<String, FleetMachine>?,
    enrollment: FleetEnrollment?,
    hubRefused: Boolean
  ) {
    if (currentSession() !== expected) return
    val previous = readSnapshot()
    if (previous == null && fleet == null && enrollment == null) return
    val update = fleetTransitions(previous, fleet, enrollment, hubRefused)
    if (previous != update.state && writeSnapshot(update.state)) {
      alerts.post(update.changes)
    }
  }

  private fun readSnapshot(): FleetSnapshot? =
    try {
      FleetSnapshotCodec.decode(snapshot.readFully().toString(Charsets.UTF_8))
    } catch (_: IOException) {
      null
    }

  private fun writeSnapshot(state: FleetSnapshot): Boolean {
    val output = try {
      snapshot.startWrite()
    } catch (_: IOException) {
      return false
    }
    return try {
      output.write(FleetSnapshotCodec.encode(state).toByteArray(Charsets.UTF_8))
      snapshot.finishWrite(output)
      true
    } catch (_: IOException) {
      snapshot.failWrite(output)
      false
    }
  }

  private companion object {
    const val INTERVAL_MINUTES = 15L
    const val WORK_NAME = "t3-mesh-fleet-poll"
  }
}
