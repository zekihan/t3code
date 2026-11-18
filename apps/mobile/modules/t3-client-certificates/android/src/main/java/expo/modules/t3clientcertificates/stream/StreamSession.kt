package expo.modules.t3clientcertificates.stream

import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.os.Build
import android.os.Bundle
import android.os.Messenger
import android.os.RemoteException
import android.util.Log
import android.view.ContextThemeWrapper
import android.view.Display
import android.view.SurfaceControlViewHost
import android.net.http.SslError
import android.webkit.ClientCertRequest
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.annotation.RequiresApi
import expo.modules.t3clientcertificates.certificateOrigin
import java.io.File
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "T3MeshStream"
private const val PRIME_TIMEOUT_MS = 8_000L

/**
 * One stream page in the stream process. Its WebView answers client certificate requests through
 * [StreamClientCertificates]; the page's own `window.ReactNativeWebView.postMessage` calls reach the
 * app process as [StreamProtocol.MESSAGE].
 */
@RequiresApi(Build.VERSION_CODES.R)
@Suppress("TooGenericExceptionCaught") // Any failure while opening must release the WebView.
internal class StreamSession(
  service: Context,
  private val id: String,
  request: OpenRequest,
  private val reply: Messenger,
  private val onEnded: () -> Unit
) {
  @Volatile private var closed = false
  private val baseUrl = request.baseUrl
  private val handler = Handler(Looper.getMainLooper())
  private val started = AtomicBoolean(false)
  private lateinit var document: String
  private val certificates =
    StreamClientCertificates(service, request.environmentUrl, request.alias, request.enrolled)
  private val direct = request.direct
  private val directPolicy = direct?.let(::DirectStreamPolicy)
  private val mainExecutor = service.mainExecutor

  private val client =
    object : WebViewClient() {
      override fun onReceivedClientCertRequest(view: WebView, request: ClientCertRequest) =
        certificates.respond(request)

      // The WebView asks only when its own validation failed: for the direct path, the agent's
      // certificate is not in the system store. Only that machine's agent, on its own host, passes.
      override fun onReceivedSslError(view: WebView, sslHandler: SslErrorHandler, error: SslError) {
        if (directPolicy != null) directPolicy.answer(sslHandler, error) else sslHandler.cancel()
      }

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) =
        !navigationAllowed(request.url.toString(), baseUrl)

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError
      ) {
        if (!request.isForMainFrame) return
        send(StreamProtocol.LOAD_ERROR) {
          putInt(StreamProtocol.CODE, error.errorCode)
          putString(StreamProtocol.DESCRIPTION, error.description.toString())
          putString(StreamProtocol.URL, request.url.toString())
        }
      }

      override fun onReceivedHttpError(
        view: WebView,
        request: WebResourceRequest,
        errorResponse: WebResourceResponse
      ) {
        if (!request.isForMainFrame) return
        send(StreamProtocol.HTTP_ERROR) {
          putInt(StreamProtocol.STATUS, errorResponse.statusCode)
          putString(StreamProtocol.URL, request.url.toString())
        }
      }

      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        send(StreamProtocol.RENDER_GONE) { putBoolean(StreamProtocol.DID_CRASH, detail.didCrash()) }
        close()
        return true
      }
    }

  private val chrome =
    object : WebChromeClient() {
      override fun onConsoleMessage(message: ConsoleMessage): Boolean {
        if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
          Log.w(
            TAG,
            "page error: ${message.message()} (${message.sourceId()}:${message.lineNumber()})"
          )
        }
        return true
      }
    }

  private val webView: WebView
  private val host: SurfaceControlViewHost

  init {
    val displays = service.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    val display =
      displays.getDisplay(request.displayId) ?: displays.getDisplay(Display.DEFAULT_DISPLAY)
    val windowContext =
      ContextThemeWrapper(
        service.createDisplayContext(display),
        android.R.style.Theme_DeviceDefault
      )
    document = readDocument(service, request.documentFile)
    // A fresh session never inherits a certificate decision remembered by an earlier page.
    WebView.clearClientCertPreferences(null)
    webView = WebView(windowContext)
    host =
      try {
        configure(webView)
        SurfaceControlViewHost(windowContext, display, request.hostToken).also {
          it.setView(webView, request.width, request.height)
        }
      } catch (error: Exception) {
        webView.destroy()
        throw error
      }
    reply.send(
      StreamProtocol.message(StreamProtocol.SURFACE, id) {
        putParcelable(StreamProtocol.SURFACE_PACKAGE, host.surfacePackage)
      }
    )
    val origin = request.alias?.takeIf { it.isNotEmpty() }?.let { request.environmentUrl }
      ?.let(::certificateOrigin)
    if (direct == null) {
      begin(origin)
    } else {
      // Decisions made for an earlier path (certificates the person or the app accepted) go first.
      webView.clearSslPreferences()
      val ready = Runnable { handler.post { begin(origin) } }
      StreamProxy.add(id, direct.host, direct.proxyPort, mainExecutor, ready)
    }
  }

  private fun begin(origin: String?) {
    if (closed) return
    if (origin == null) {
      startPage()
    } else {
      // Chromium never asks for a client certificate on a WebSocket handshake that has no
      // decision yet; it cancels it. One ordinary request to the origin first makes the decision
      // the stream's WebSocket then reuses.
      webView.loadDataWithBaseURL(baseUrl, primeDocument(origin), "text/html", "utf-8", null)
      handler.postDelayed(::startPage, PRIME_TIMEOUT_MS)
    }
  }

  private fun startPage() {
    if (closed || !started.compareAndSet(false, true)) return
    handler.removeCallbacksAndMessages(null)
    // Takes effect with the next load, so the stream page never sees the priming bridge.
    webView.removeJavascriptInterface("T3StreamPrime")
    webView.loadDataWithBaseURL(baseUrl, document, "text/html", "utf-8", null)
  }

  private fun primeDocument(origin: String): String {
    val url = "$origin.well-known/t3/environment"
    return "<!doctype html><script>fetch(${JSONObject.quote(url)}," +
      "{mode:\"no-cors\",credentials:\"omit\",cache:\"no-store\"})" +
      ".catch(function(){}).then(function(){T3StreamPrime.done()})</script>"
  }

  fun resize(width: Int, height: Int) {
    if (!closed && width > 0 && height > 0) host.relayout(width, height)
  }

  fun evaluate(script: String) {
    if (!closed) webView.evaluateJavascript(script, null)
  }

  fun close() {
    if (closed) return
    closed = true
    handler.removeCallbacksAndMessages(null)
    if (direct != null) StreamProxy.remove(id, mainExecutor)
    certificates.shutdown()
    host.release()
    webView.stopLoading()
    webView.destroy()
    onEnded()
  }

  private fun send(what: Int, fill: Bundle.() -> Unit) {
    if (closed) return
    try {
      reply.send(StreamProtocol.message(what, id, fill = fill))
    } catch (_: RemoteException) {
      // The app process is gone; the service ends with its last client.
    }
  }

  @Suppress("SetJavaScriptEnabled") // The page is the app's own synthetic document.
  private fun configure(view: WebView) {
    view.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      allowContentAccess = false
      mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
      mediaPlaybackRequiresUserGesture = false
      javaScriptCanOpenWindowsAutomatically = false
      setSupportMultipleWindows(false)
      setSupportZoom(false)
      setGeolocationEnabled(false)
    }
    CookieManager.getInstance().setAcceptThirdPartyCookies(view, true)
    view.addJavascriptInterface(PageBridge(), "ReactNativeWebView")
    view.addJavascriptInterface(PrimeBridge(), "T3StreamPrime")
    view.webViewClient = client
    view.webChromeClient = chrome
  }

  private fun readDocument(service: Context, path: String): String {
    val directory = File(service.cacheDir, StreamProtocol.DOCUMENT_DIRECTORY).canonicalFile
    val file = File(path).canonicalFile
    require(file.parentFile == directory) { "Stream document is outside the document directory." }
    return try {
      file.readText()
    } finally {
      file.delete()
    }
  }

  private inner class PrimeBridge {
    @JavascriptInterface
    fun done() {
      handler.post(::startPage)
    }
  }

  private inner class PageBridge {
    @JavascriptInterface
    fun postMessage(data: String) {
      if (data.length > StreamProtocol.MAX_MESSAGE_CHARS) {
        Log.w(TAG, "Dropped an oversized page message (${data.length} chars)")
        return
      }
      send(StreamProtocol.MESSAGE) { putString(StreamProtocol.DATA, data) }
    }
  }
}
