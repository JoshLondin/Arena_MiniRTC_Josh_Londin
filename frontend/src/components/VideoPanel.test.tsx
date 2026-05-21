import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { VideoPanel } from "./VideoPanel";

afterEach(() => {
  cleanup();
});

describe("VideoPanel", () => {
  it("shows a large muted indicator when the camera is off", () => {
    const { getByLabelText } = render(
      <VideoPanel
        label="Bob"
        stream={null}
        isCameraEnabled={false}
        isMuted
        showAudioIndicator
      />
    );

    expect(getByLabelText("Audio muted").className).toContain("audio-indicator-large");
  });

  it("shows a small audio indicator when the camera is on", () => {
    const { getByLabelText } = render(
      <VideoPanel
        label="Bob"
        stream={null}
        isCameraEnabled
        isMuted={false}
        showAudioIndicator
      />
    );

    expect(getByLabelText("Audio on").className).toContain("audio-indicator-small");
  });

  it("shows a centered name instead of bottom labels and audio indicators", () => {
    const { getByText, queryByLabelText, queryByText } = render(
      <VideoPanel
        label="Bob"
        stream={null}
        isCameraEnabled={false}
        isMuted
        showAudioIndicator
        centerLabel="Bob is in the call"
      />
    );

    expect(getByText("Bob is in the call").className).toContain("video-panel-name");
    expect(queryByText("Bob", { exact: true })).toBeNull();
    expect(queryByLabelText("Audio muted")).toBeNull();
  });
});
