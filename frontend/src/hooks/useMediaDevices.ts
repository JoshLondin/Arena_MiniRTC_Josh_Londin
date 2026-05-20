import { useCallback } from "react";

type MediaResult = {
  stream: MediaStream;
  warning: string | null;
};

export function useMediaDevices() {
  const getCallMedia = useCallback(async (): Promise<MediaResult> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      return { stream, warning: null };
    } catch (error) {
      try {
        const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        return {
          stream: audioOnly,
          warning: "Camera is unavailable, so this call will continue with audio only."
        };
      } catch {
        throw new Error("Microphone access is required to start or join a call.");
      }
    }
  }, []);

  const getVideoTrack = useCallback(async (): Promise<MediaStreamTrack> => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    const [track] = stream.getVideoTracks();
    if (!track) {
      stream.getTracks().forEach((streamTrack) => streamTrack.stop());
      throw new Error("Camera is unavailable.");
    }
    return track;
  }, []);

  return { getCallMedia, getVideoTrack };
}
