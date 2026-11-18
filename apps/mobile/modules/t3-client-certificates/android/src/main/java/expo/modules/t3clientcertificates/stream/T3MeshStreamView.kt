package expo.modules.t3clientcertificates.stream

import android.content.Context
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Display
import android.view.SurfaceControlViewHost
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import expo.modules.t3clientcertificates.T3CertificateTransport
import expo.modules.t3clientcertificates.certificateOrigin
import java.io.File
import java.util.UUID

private const val DETACH_GRACE_MS = 250L
private const val HOST_TOKEN_RETRY_MS = 50L
private const val HOST_TOKEN_RETRIES = 200
private const val STALE_DOCUMENT_MS = 60L * 60 * 1000

/**
 * The app-process side of one stream: a SurfaceView that shows a page running in [StreamService].
 * The page is opened once the view is attached, sized and has its document, and closed when the
 * view is destroyed or stays detached. If the stream process ends, the view reports it like a
 * crashed WebView renderer and stays closed; the screen decides whether to mount a new view.
 */
class T3MeshStreamView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  private val onMessage by EventDispatcher()
  private val onError by EventDispatcher()
  private val onHttpError by EventDispatcher()
  private val onRenderProcessGone by EventDispatcher()

  private val surface = SurfaceView(context)
  private val handler = Handler(Looper.getMainLooper())
  private val closeWhenDetached = Runnable { closeSession() }
  private val openAgain = Runnable { maybeOpen() }
  private var tokenRetries = 0

  var html: String? = null
  var baseUrl: String? = null
  var certificateUrl: String? = null

  /** Interactive streams take touch and keyboard input, which needs the surface above the window. */
  var interactive = false

  /** React Native overlays (status, dialogs, PDF) sit under an interactive surface, so it hides. */
  var hidden = true

  private var session: String? = null
  private var opened: List<String?>? = null

  // The document whose session ended on its own. It stays closed: the screen mounts a new view.
  private var goneDocument: List<String?>? = null

  private val listener =
    object : StreamListener {
      override fun onSurface(surfacePackage: SurfaceControlViewHost.SurfacePackage) {
        if (session != null && isAttachedToWindow) {
          surface.setChildSurfacePackage(surfacePackage)
        } else {
          surfacePackage.release()
        }
      }

      override fun onMessage(data: String) {
        this@T3MeshStreamView.onMessage(mapOf("data" to data))
      }

      override fun onLoadError(code: Int, description: String, url: String) {
        this@T3MeshStreamView.onError(
          mapOf("code" to code, "description" to description, "url" to url)
        )
      }

      override fun onHttpError(statusCode: Int, url: String) {
        this@T3MeshStreamView.onHttpError(mapOf("statusCode" to statusCode, "url" to url))
      }

      override fun onGone(didCrash: Boolean) {
        goneDocument = opened
        endSession()
        this@T3MeshStreamView.onRenderProcessGone(mapOf("didCrash" to didCrash))
      }
    }

  init {
    addView(
      surface,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    )
  }

  fun propsUpdated() {
    surface.setZOrderOnTop(interactive)
    surface.visibility = if (hidden) View.INVISIBLE else View.VISIBLE
    if (session != null && opened != documentIdentity()) closeSession()
    tokenRetries = 0
    maybeOpen()
  }

  /** The page's `window.ReactNativeWebView.postMessage` counterpart in the other direction. */
  fun inject(script: String) {
    handler.post { session?.let { StreamHub.evaluate(it, script) } }
  }

  fun destroy() {
    handler.removeCallbacksAndMessages(null)
    closeSession()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    handler.removeCallbacks(closeWhenDetached)
    maybeOpen()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    // Screens detach and reattach their views while transitioning; only a lasting detach closes.
    handler.postDelayed(closeWhenDetached, DETACH_GRACE_MS)
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    val open = session
    if (open == null) maybeOpen() else StreamHub.resize(open, width, height)
  }

  private fun documentIdentity() = listOf(html, baseUrl, certificateUrl)

  @Suppress("DEPRECATION") // getHostToken is the only host token API before Android 15.
  private fun maybeOpen() {
    val document = html
    val base = baseUrl
    val token = surface.hostToken
    if (document == null || base == null) return
    if (token != null) {
      tokenRetries = 0
      open(document, base, token)
    } else if (session == null && isAttachedToWindow && tokenRetries++ < HOST_TOKEN_RETRIES) {
      // The host token appears only after the window has laid the SurfaceView out, which can be
      // after attach and size; nothing else calls this again.
      handler.removeCallbacks(openAgain)
      handler.postDelayed(openAgain, HOST_TOKEN_RETRY_MS)
    }
  }

  private fun canOpen() =
    session == null &&
      documentIdentity() != goneDocument &&
      isAttachedToWindow &&
      width > 0 &&
      height > 0

  private fun open(document: String, base: String, token: IBinder) {
    if (!canOpen()) return
    val id = UUID.randomUUID().toString()
    val origin = certificateUrl?.let(::certificateOrigin)
    // The app process owns the choice; the stream process only receives it with the request.
    val transport = T3CertificateTransport.install(context)
    val alias = origin?.let { transport.aliasFor(it) }
    // The direct path (A8), when the machine is home and its agent passed the probe; else null.
    val direct = origin?.let { transport.direct.streamRouting(id, it) }
    val request =
      OpenRequest(
        environmentUrl = certificateUrl,
        alias = alias,
        enrolled = direct?.identity ?: alias?.let { transport.enrolledStreamIdentity(it) },
        direct = direct?.toStream(),
        documentFile = writeDocument(id, document).path,
        baseUrl = base,
        hostToken = token,
        displayId = display?.displayId ?: Display.DEFAULT_DISPLAY,
        width = width,
        height = height
      )
    session = id
    opened = documentIdentity()
    StreamHub.open(context, id, request, listener)
  }

  private fun closeSession() {
    val id = session ?: return
    endSession()
    StreamHub.close(id)
  }

  private fun endSession() {
    session?.let { T3CertificateTransport.install(context).direct.streamClosed(it) }
    session = null
    opened = null
    surface.clearChildSurfacePackage()
  }

  private fun writeDocument(id: String, document: String): File {
    val directory = File(context.cacheDir, StreamProtocol.DOCUMENT_DIRECTORY).apply { mkdirs() }
    val cutoff = System.currentTimeMillis() - STALE_DOCUMENT_MS
    directory.listFiles()?.filter { it.lastModified() < cutoff }?.forEach { it.delete() }
    return File(directory, "$id.html").apply { writeText(document) }
  }
}
