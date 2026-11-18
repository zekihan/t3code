/**
 * An interactive stream's native surface sits above React Native's own views, so it must step
 * aside while the screen shows something over the stream: the status overlay before frames
 * arrive and after a failure, a page dialog, or the file chooser prompt. The messages the stream
 * page posts tell which of those is showing, in the same terms the stream screens use.
 */
export interface StreamOverlayState {
  readonly streaming: boolean;
  readonly dialog: boolean;
  readonly chooser: boolean;
  readonly controlledByYou: boolean;
}

export const INITIAL_STREAM_OVERLAY: StreamOverlayState = {
  streaming: false,
  dialog: false,
  chooser: false,
  controlledByYou: false,
};

export function streamOverlayAfterMessage(
  state: StreamOverlayState,
  data: string,
): StreamOverlayState {
  const message = parse(data);
  if (message === null) return state;
  switch (message.type) {
    case "status":
      if (message.status === "streaming")
        return state.streaming ? state : { ...state, streaming: true };
      return INITIAL_STREAM_OVERLAY;
    case "control": {
      const dialog = message.dialog != null;
      const controlledByYou = message.controller === "you";
      return state.dialog === dialog && state.controlledByYou === controlledByYou
        ? state
        : { ...state, dialog, controlledByYou };
    }
    case "fileChooser": {
      const chooser = message.chooser != null;
      return state.chooser === chooser ? state : { ...state, chooser };
    }
    case "unauthorized":
    case "gone":
    case "hostSetup":
      return INITIAL_STREAM_OVERLAY;
    default:
      return state;
  }
}

/** The file chooser prompt only shows for the controlling viewer; a page dialog always shows. */
export const streamSurfaceHidden = (state: StreamOverlayState) =>
  !state.streaming || state.dialog || (state.chooser && state.controlledByYou);

interface PageMessage {
  readonly type?: unknown;
  readonly status?: unknown;
  readonly controller?: unknown;
  readonly dialog?: unknown;
  readonly chooser?: unknown;
}

function parse(data: string): (PageMessage & { readonly type: string }) | null {
  try {
    const message: unknown = JSON.parse(data);
    if (typeof message !== "object" || message === null) return null;
    const candidate = message as PageMessage;
    return typeof candidate.type === "string"
      ? (candidate as PageMessage & { readonly type: string })
      : null;
  } catch {
    return null;
  }
}
