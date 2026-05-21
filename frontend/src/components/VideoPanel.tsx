import { useEffect, useRef } from "react";

type VideoPanelProps = {
  label: string;
  stream: MediaStream | null;
  isCameraEnabled?: boolean;
  isMuted?: boolean;
  muted?: boolean;
  showAudioIndicator?: boolean;
  centerLabel?: string;
};

type AudioIconProps = {
  isMuted: boolean;
};

function AudioIcon({ isMuted }: AudioIconProps) {
  return (
    <svg aria-hidden="true" viewBox="0 0 64 64" focusable="false">
      <path
        d="M8 25h11l16-14c2-2 5-.5 5 2.2v37.6c0 2.7-3 4.2-5 2.2L19 39H8a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4Z"
        fill="currentColor"
      />
      <path
        d="M47 24c2.2 2.3 3.5 5.1 3.5 8S49.2 37.7 47 40"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="5"
      />
      <path
        d="M53 17c4 4 6.5 9.3 6.5 15S57 43 53 47"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="5"
      />
      {isMuted ? (
        <path
          d="M12 9l43 46"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="6"
        />
      ) : null}
    </svg>
  );
}

export function VideoPanel({
  label,
  stream,
  isCameraEnabled = true,
  isMuted = false,
  muted = false,
  showAudioIndicator = false,
  centerLabel
}: VideoPanelProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioLabel = isMuted ? "Audio muted" : "Audio on";
  const showCenteredLabel = centerLabel !== undefined;

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div
      className={[
        "video-panel",
        isCameraEnabled ? "" : "video-panel-camera-off",
        showCenteredLabel ? "video-panel-centered-label" : ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <video ref={videoRef} autoPlay playsInline muted={muted} />
      {showCenteredLabel ? <span className="video-panel-name">{centerLabel}</span> : null}
      {!showCenteredLabel && !isCameraEnabled && showAudioIndicator ? (
        <span className="audio-indicator audio-indicator-large" role="img" aria-label={audioLabel}>
          <AudioIcon isMuted={isMuted} />
        </span>
      ) : null}
      {!showCenteredLabel ? <span className="video-panel-label">{label}</span> : null}
      {!showCenteredLabel && isCameraEnabled && showAudioIndicator ? (
        <span className="audio-indicator audio-indicator-small" role="img" aria-label={audioLabel}>
          <AudioIcon isMuted={isMuted} />
        </span>
      ) : null}
    </div>
  );
}
