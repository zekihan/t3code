package expo.modules.t3clientcertificates.stream

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.RemoteException
import android.view.SurfaceControlViewHost
import androidx.core.os.BundleCompat

/** What a stream view hears from its session in the stream process. Called on the main thread. */
internal interface StreamListener {
  fun onSurface(surfacePackage: SurfaceControlViewHost.SurfacePackage)

  fun onMessage(data: String)

  fun onLoadError(code: Int, description: String, url: String)

  fun onHttpError(statusCode: Int, url: String)

  /** The session ended without the app asking: the process died, was restarted, or the page's renderer crashed. */
  fun onGone(didCrash: Boolean)
}

/**
 * The app-process end of the bridge to [StreamService]. One bound connection serves every stream
 * view; it is dropped after the last view closes, and again whenever the stream process ends.
 * Everything runs on the main thread except [restart], which may be called from any thread.
 */
internal object StreamHub {
  private const val IDLE_UNBIND_MS = 30_000L

  private val main = Handler(Looper.getMainLooper())
  private val listeners = HashMap<String, StreamListener>()
  private val waiting = LinkedHashMap<String, OpenRequest>()
  private val replies = Messenger(Handler(Looper.getMainLooper()) { handleEvent(it) })
  private val idleUnbind = Runnable { if (listeners.isEmpty()) disconnect() }

  private var context: Context? = null
  private var service: Messenger? = null
  private var connection: ServiceConnection? = null

  private val serviceConnection =
    object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName, binder: IBinder) {
        service = Messenger(binder)
        val requests = waiting.toMap()
        waiting.clear()
        requests.forEach { (session, request) -> send(request.toMessage(session, replies)) }
      }

      override fun onServiceDisconnected(name: ComponentName) = gone(didCrash = true)

      override fun onBindingDied(name: ComponentName) = gone(didCrash = true)

      override fun onNullBinding(name: ComponentName) = gone(didCrash = true)
    }

  fun open(context: Context, session: String, request: OpenRequest, listener: StreamListener) {
    main.removeCallbacks(idleUnbind)
    listeners[session] = listener
    if (service != null) {
      send(request.toMessage(session, replies))
      return
    }
    waiting[session] = request
    connect(context.applicationContext)
  }

  fun resize(session: String, width: Int, height: Int) {
    command(StreamProtocol.RESIZE, session) {
      putInt(StreamProtocol.WIDTH, width)
      putInt(StreamProtocol.HEIGHT, height)
    }
  }

  fun evaluate(session: String, script: String) {
    command(StreamProtocol.EVALUATE, session) { putString(StreamProtocol.SCRIPT, script) }
  }

  fun close(session: String) {
    waiting.remove(session)
    command(StreamProtocol.CLOSE, session)
    listeners.remove(session)
    if (listeners.isEmpty()) main.postDelayed(idleUnbind, IDLE_UNBIND_MS)
  }

  /** Ends the stream process whatever it is doing; the open views hear [StreamListener.onGone]. */
  fun restart(context: Context) {
    main.post {
      val victims = listeners.values.toList()
      disconnect()
      StreamProcess.kill(context)
      victims.forEach { it.onGone(false) }
    }
  }

  private fun command(what: Int, session: String, fill: Bundle.() -> Unit = {}) {
    if (!listeners.containsKey(session) || service == null) return
    send(StreamProtocol.message(what, session, replies, fill))
  }

  private fun send(message: Message) {
    try {
      service?.send(message)
    } catch (_: RemoteException) {
      gone(didCrash = true)
    }
  }

  private fun connect(context: Context) {
    if (connection != null) return
    this.context = context
    connection = serviceConnection
    val bound =
      context.bindService(
        Intent(context, StreamService::class.java),
        serviceConnection,
        Context.BIND_AUTO_CREATE
      )
    if (!bound) gone(didCrash = true)
  }

  private fun disconnect() {
    main.removeCallbacks(idleUnbind)
    waiting.clear()
    listeners.clear()
    service = null
    if (connection != null) {
      connection = null
      // The service may already be gone; the system has nothing left to unbind then.
      runCatching { context?.unbindService(serviceConnection) }
    }
  }

  private fun gone(didCrash: Boolean) {
    val victims = listeners.values.toList()
    disconnect()
    victims.forEach { it.onGone(didCrash) }
  }

  private fun handleEvent(message: Message): Boolean {
    val data = message.data
    val session = data.getString(StreamProtocol.SESSION)
    val listener = session?.let { listeners[it] }
    if (session != null && listener != null) dispatch(session, listener, message.what, data)
    return true
  }

  private fun dispatch(session: String, listener: StreamListener, what: Int, data: Bundle) {
    when (what) {
      StreamProtocol.SURFACE ->
        BundleCompat.getParcelable(
          data,
          StreamProtocol.SURFACE_PACKAGE,
          SurfaceControlViewHost.SurfacePackage::class.java
        )
          ?.let(listener::onSurface)
      StreamProtocol.MESSAGE -> data.getString(StreamProtocol.DATA)?.let(listener::onMessage)
      StreamProtocol.LOAD_ERROR ->
        listener.onLoadError(
          data.getInt(StreamProtocol.CODE),
          data.getString(StreamProtocol.DESCRIPTION).orEmpty(),
          data.getString(StreamProtocol.URL).orEmpty()
        )
      StreamProtocol.HTTP_ERROR ->
        listener.onHttpError(
          data.getInt(StreamProtocol.STATUS),
          data.getString(StreamProtocol.URL).orEmpty()
        )
      StreamProtocol.RENDER_GONE -> {
        listeners.remove(session)
        waiting.remove(session)
        listener.onGone(data.getBoolean(StreamProtocol.DID_CRASH))
        if (listeners.isEmpty()) main.postDelayed(idleUnbind, IDLE_UNBIND_MS)
      }
    }
  }
}
