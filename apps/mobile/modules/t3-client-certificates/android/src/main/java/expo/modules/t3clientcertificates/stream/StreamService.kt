package expo.modules.t3clientcertificates.stream

import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.util.Log

private const val TAG = "T3MeshStream"

/**
 * Runs in the `:stream` process. Each session is one WebView, drawn into the app process's
 * SurfaceView through a SurfaceControlViewHost. The app process binds to it; when the last client
 * unbinds, the process ends so the next stream starts with no state from this one.
 */
class StreamService : Service() {
  private val sessions = HashMap<String, StreamSession>()
  private val messenger = Messenger(Handler(Looper.getMainLooper()) { handle(it) })

  override fun onBind(intent: Intent?): IBinder = messenger.binder

  override fun onUnbind(intent: Intent?): Boolean {
    closeAll()
    return false
  }

  override fun onDestroy() {
    closeAll()
    super.onDestroy()
    Process.killProcess(Process.myPid())
  }

  private fun closeAll() {
    sessions.values.toList().forEach { it.close() }
    sessions.clear()
  }

  private fun handle(message: Message): Boolean {
    val data = message.data
    val id = data.getString(StreamProtocol.SESSION) ?: return true
    when (message.what) {
      StreamProtocol.OPEN -> open(id, message)
      StreamProtocol.RESIZE ->
        sessions[id]?.resize(data.getInt(StreamProtocol.WIDTH), data.getInt(StreamProtocol.HEIGHT))
      StreamProtocol.EVALUATE ->
        data.getString(StreamProtocol.SCRIPT)?.let { sessions[id]?.evaluate(it) }
      StreamProtocol.CLOSE -> sessions.remove(id)?.close()
    }
    return true
  }

  @Suppress("TooGenericExceptionCaught") // A failed session is reported, not a crash.
  private fun open(id: String, message: Message) {
    val reply = message.replyTo ?: return
    if (sessions.containsKey(id)) return
    val request = OpenRequest.from(message.data)
    try {
      check(Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        "Streams need Android 11 (API 30) or newer."
      }
      checkNotNull(request) { "Incomplete stream request." }
      sessions[id] = StreamSession(this, id, request, reply) { sessions.remove(id) }
    } catch (error: Exception) {
      Log.w(TAG, "Could not open stream session", error)
      reply.send(
        StreamProtocol.message(StreamProtocol.LOAD_ERROR, id) {
          putInt(StreamProtocol.CODE, -1)
          putString(StreamProtocol.DESCRIPTION, error.message ?: "Could not open the stream.")
          putString(StreamProtocol.URL, request?.baseUrl.orEmpty())
        }
      )
    }
  }
}
