import { requireNativeView } from "expo";
import { Component, createRef, type Ref } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import type { WebViewMessageEvent, WebViewProps } from "react-native-webview";

import {
  INITIAL_STREAM_OVERLAY,
  streamOverlayAfterMessage,
  streamSurfaceHidden,
  type StreamOverlayState,
} from "./streamOverlay";
import type { StreamWebViewExtras } from "./streamWebView";

export type { StreamWebViewExtras } from "./streamWebView";

interface NativeStreamHandle {
  injectJavaScript(script: string): Promise<void>;
}

interface NativeStreamProps extends ViewProps {
  readonly ref?: Ref<NativeStreamHandle>;
  readonly html?: string;
  readonly baseUrl?: string;
  readonly certificateUrl?: string;
  readonly interactive: boolean;
  readonly hidden: boolean;
  readonly onMessage: (event: NativeSyntheticEvent<{ readonly data: string }>) => void;
  readonly onError: (event: NativeSyntheticEvent<object>) => void;
  readonly onHttpError: (event: NativeSyntheticEvent<object>) => void;
  readonly onRenderProcessGone: (event: NativeSyntheticEvent<object>) => void;
}

// The page runs in the `:stream` process and is drawn into this view, so a page that can present
// the client certificate never shares a WebView with the rest of the app.
const NativeStream = requireNativeView<NativeStreamProps>("T3MeshStream");

type Handlers = Pick<
  WebViewProps,
  "onMessage" | "onError" | "onHttpError" | "onRenderProcessGone" | "source" | "style"
>;

/**
 * The part of `react-native-webview`'s API that the device stream and the browser preview stream
 * use, on top of the native stream view. Navigation is limited natively to `about:blank` and the
 * document's own base URL, so `onShouldStartLoadWithRequest` is not consulted.
 */
export class WebView<P = object> extends Component<
  WebViewProps & StreamWebViewExtras & P,
  { readonly overlay: StreamOverlayState }
> {
  override state = { overlay: INITIAL_STREAM_OVERLAY };
  private readonly native = createRef<NativeStreamHandle>();

  injectJavaScript = (script: string) => {
    this.native.current?.injectJavaScript(script).catch(() => undefined);
  };

  private readonly showOverlay = (next: (overlay: StreamOverlayState) => StreamOverlayState) =>
    this.setState(({ overlay }) => {
      const updated = next(overlay);
      return updated === overlay ? null : { overlay: updated };
    });

  private readonly handleMessage = (event: NativeSyntheticEvent<{ readonly data: string }>) => {
    this.showOverlay((overlay) => streamOverlayAfterMessage(overlay, event.nativeEvent.data));
    (this.props as Handlers).onMessage?.(event as unknown as WebViewMessageEvent);
  };

  private readonly handleError = (event: NativeSyntheticEvent<object>) => {
    this.showOverlay(() => INITIAL_STREAM_OVERLAY);
    (this.props as Handlers).onError?.(event as never);
  };

  private readonly handleHttpError = (event: NativeSyntheticEvent<object>) => {
    this.showOverlay(() => INITIAL_STREAM_OVERLAY);
    (this.props as Handlers).onHttpError?.(event as never);
  };

  private readonly handleRenderProcessGone = (event: NativeSyntheticEvent<object>) => {
    this.showOverlay(() => INITIAL_STREAM_OVERLAY);
    (this.props as Handlers).onRenderProcessGone?.(event as never);
  };

  override render() {
    const { source, style, certificateUrl, interactive, hidden } = this.props as Handlers &
      StreamWebViewExtras;
    const document = source !== undefined && "html" in source ? source : undefined;
    return (
      <NativeStream
        ref={this.native}
        style={style}
        {...(document ? { html: document.html, baseUrl: document.baseUrl } : {})}
        certificateUrl={certificateUrl}
        interactive={interactive ?? false}
        hidden={hidden === true || streamSurfaceHidden(this.state.overlay)}
        onMessage={this.handleMessage}
        onError={this.handleError}
        onHttpError={this.handleHttpError}
        onRenderProcessGone={this.handleRenderProcessGone}
      />
    );
  }
}
