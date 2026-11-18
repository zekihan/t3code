import { WebView } from "react-native-webview";

/**
 * What the Android stream view takes beyond a WebView's own props. The other platforms keep the
 * real WebView and ignore these (streamWebView.android.tsx).
 */
export interface StreamWebViewExtras {
  /** The environment the page streams from; its stored client certificate is the only one the page may use. */
  readonly certificateUrl?: string;
  /** Takes touch and keyboard input. Non-interactive streams leave input to the screen. */
  readonly interactive?: boolean;
  /** Hides the stream while the screen shows its own view over it. */
  readonly hidden?: boolean;
}

export { WebView };
