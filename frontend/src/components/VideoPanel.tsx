import { useEffect, useRef } from "react";

type VideoPanelProps = {
  label: string;
  stream: MediaStream | null;
  muted?: boolean;
};

export function VideoPanel({ label, stream, muted = false }: VideoPanelProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className="video-panel">
      <video ref={videoRef} autoPlay playsInline muted={muted} />
      <span>{label}</span>
    </div>
  );
}

