import { useCallback, useEffect, useRef } from "react";

import { WS_BASE_URL } from "../api/rooms";
import type { ClientSignalingMessage, ServerSignalingMessage } from "../types/signaling";

type UseWebSocketOptions = {
  roomCode: string | null;
  participantId: string | null;
  participantToken: string | null;
  enabled: boolean;
  onMessage: (message: ServerSignalingMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

export function useWebSocket({
  roomCode,
  participantId,
  participantToken,
  enabled,
  onMessage,
  onOpen,
  onClose
}: UseWebSocketOptions) {
  const socketRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<number | null>(null);

  const sendMessage = useCallback((message: ClientSignalingMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }, []);

  useEffect(() => {
    if (!enabled || !roomCode || !participantId || !participantToken) {
      return;
    }
    const params = new URLSearchParams({
      participant_id: participantId,
      participant_token: participantToken
    });
    const socket = new WebSocket(`${WS_BASE_URL}/ws/rooms/${roomCode}?${params.toString()}`);
    socketRef.current = socket;

    socket.onopen = () => {
      onOpen?.();
      heartbeatRef.current = window.setInterval(() => {
        sendMessage({ type: "heartbeat", payload: { participant_id: participantId } });
      }, 10_000);
    };

    socket.onmessage = (event) => {
      onMessage(JSON.parse(event.data) as ServerSignalingMessage);
    };

    socket.onclose = () => {
      if (heartbeatRef.current !== null) {
        window.clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      onClose?.();
    };

    return () => {
      if (heartbeatRef.current !== null) {
        window.clearInterval(heartbeatRef.current);
      }
      socket.close();
      socketRef.current = null;
    };
  }, [enabled, onClose, onMessage, onOpen, participantId, participantToken, roomCode, sendMessage]);

  return { sendMessage };
}
