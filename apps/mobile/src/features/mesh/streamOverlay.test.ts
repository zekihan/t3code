import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_STREAM_OVERLAY,
  streamOverlayAfterMessage,
  streamSurfaceHidden,
  type StreamOverlayState,
} from "./streamOverlay";

const post = (state: StreamOverlayState, message: object) =>
  streamOverlayAfterMessage(state, JSON.stringify(message));
const streaming = post(INITIAL_STREAM_OVERLAY, { type: "status", status: "streaming" });

describe("stream overlay", () => {
  it("hides the surface until frames arrive", () => {
    expect(streamSurfaceHidden(INITIAL_STREAM_OVERLAY)).toBe(true);
    expect(
      streamSurfaceHidden(post(INITIAL_STREAM_OVERLAY, { type: "status", status: "connecting" })),
    ).toBe(true);
    expect(streamSurfaceHidden(streaming)).toBe(false);
  });

  it("hides the surface again when the stream stops or fails", () => {
    for (const message of [
      { type: "status", status: "connecting" },
      { type: "status", status: "error", detail: "nope" },
      { type: "unauthorized" },
      { type: "gone" },
      { type: "hostSetup", need: "x", command: "y" },
    ]) {
      expect(post(streaming, message)).toBe(INITIAL_STREAM_OVERLAY);
    }
  });

  it("hides the surface under a page dialog and shows it when the dialog closes", () => {
    const open = post(streaming, {
      type: "control",
      controller: "another-viewer",
      dialog: { type: "alert" },
    });
    expect(streamSurfaceHidden(open)).toBe(true);
    const closed = post(open, { type: "control", controller: "another-viewer", dialog: null });
    expect(streamSurfaceHidden(closed)).toBe(false);
  });

  it("hides the surface under the file chooser prompt only for the controlling viewer", () => {
    const chooser = post(streaming, { type: "fileChooser", chooser: { multiple: false } });
    expect(streamSurfaceHidden(chooser)).toBe(false);
    const controlling = post(chooser, { type: "control", controller: "you", dialog: null });
    expect(streamSurfaceHidden(controlling)).toBe(true);
    expect(streamSurfaceHidden(post(controlling, { type: "fileChooser", chooser: null }))).toBe(
      false,
    );
  });

  it("drops dialog and chooser state with the connection", () => {
    const open = post(streaming, { type: "control", controller: "you", dialog: { type: "alert" } });
    const reconnecting = post(open, { type: "status", status: "connecting" });
    const back = post(reconnecting, { type: "status", status: "streaming" });
    expect(streamSurfaceHidden(back)).toBe(false);
  });

  it("returns the same state when a message changes nothing", () => {
    expect(post(streaming, { type: "status", status: "streaming" })).toBe(streaming);
    expect(post(streaming, { type: "viewport", width: 1, height: 2 })).toBe(streaming);
    expect(post(streaming, { type: "control", controller: "agent", dialog: null })).toEqual({
      ...streaming,
      controlledByYou: false,
    });
  });

  it("ignores messages it cannot read", () => {
    for (const data of ["", "not json", "null", "42", '"status"', "{}", '{"type":7}']) {
      expect(streamOverlayAfterMessage(streaming, data)).toBe(streaming);
    }
  });
});
