package expo.modules.t3clientcertificates.stream

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * A stand-in for `react-native-webview` on Android for the device stream and the browser preview
 * stream: the page runs in the `:stream` process and is drawn into this view's surface.
 */
class T3MeshStreamModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3MeshStream")

    View(T3MeshStreamView::class) {
      Events("onMessage", "onError", "onHttpError", "onRenderProcessGone")
      Prop("html") { view: T3MeshStreamView, value: String? -> view.html = value }
      Prop("baseUrl") { view: T3MeshStreamView, value: String? -> view.baseUrl = value }
      Prop("certificateUrl") { view: T3MeshStreamView, value: String? ->
        view.certificateUrl = value
      }
      Prop("interactive") { view: T3MeshStreamView, value: Boolean -> view.interactive = value }
      Prop("hidden") { view: T3MeshStreamView, value: Boolean -> view.hidden = value }
      AsyncFunction("injectJavaScript") { view: T3MeshStreamView, script: String ->
        view.inject(script)
      }
      OnViewDidUpdateProps { view: T3MeshStreamView -> view.propsUpdated() }
      OnViewDestroys { view: T3MeshStreamView -> view.destroy() }
    }
  }
}
