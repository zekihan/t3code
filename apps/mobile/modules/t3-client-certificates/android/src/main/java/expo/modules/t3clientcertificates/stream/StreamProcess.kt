package expo.modules.t3clientcertificates.stream

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Process
import android.webkit.WebView
import java.io.File

/**
 * The `:stream` process hosts the device and browser preview stream WebViews so that only they
 * can present a client certificate, and only to the environment they were opened for.
 */
object StreamProcess {
  /**
   * Called from `MainApplication.onCreate` in every process. In `:stream` it gives WebView its own
   * data directory, before anything can touch WebView, and returns true: the caller must then skip
   * React Native, Expo and the certificate transport, which the stream does not use.
   */
  @JvmStatic
  fun onApplicationCreate(application: Application): Boolean {
    if (!isStreamProcess(application)) return false
    // API 28 introduced the data directory suffix; older WebViews allowed several processes.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      WebView.setDataDirectorySuffix(STREAM_DATA_DIRECTORY_SUFFIX)
    }
    return true
  }

  /** True in the `:stream` process, for callbacks that must not reach Expo or React Native there. */
  @JvmStatic
  fun isStreamProcess(application: Application) =
    isStreamProcessName(currentProcessName(application), application.packageName)

  /**
   * Ends the stream process, if one is running. Open streams report that their process is gone,
   * and the next stream starts a fresh process. Called when a stored certificate alias changes,
   * so no WebView keeps a certificate decision made for the old identity.
   */
  @JvmStatic
  fun restart(context: Context) {
    StreamHub.restart(context.applicationContext)
  }

  internal fun kill(context: Context) {
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return
    val name = context.packageName + STREAM_PROCESS_SUFFIX
    manager.runningAppProcesses
      ?.filter { it.processName == name }
      ?.forEach { Process.killProcess(it.pid) }
  }

  private fun currentProcessName(application: Application): String? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      Application.getProcessName()
    } else {
      commandLineProcessName(application)
    }

  // Before API 28 the process name is the first entry of /proc/self/cmdline.
  private fun commandLineProcessName(application: Application): String? =
    runCatching { File("/proc/self/cmdline").readBytes().takeWhile { it != 0.toByte() } }
      .getOrNull()
      ?.toByteArray()
      ?.toString(Charsets.UTF_8)
      ?.takeIf { it.isNotEmpty() }
      ?: application.packageName
}
