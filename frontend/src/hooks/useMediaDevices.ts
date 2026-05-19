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

  return { getCallMedia };
}

