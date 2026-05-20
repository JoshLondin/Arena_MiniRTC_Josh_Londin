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
  onFatalClose?: () => void;
};

export function useWebSocket({
  roomCode,
  participantId,
  participantToken,
  enabled,
  onMessage,
  onOpen,
  onClose,
  onFatalClose
}: UseWebSocketOptions) {
  const socketRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const onMessageRef = useRef(onMessage);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  const onFatalCloseRef = useRef(onFatalClose);

  useEffect(() => {
    onMessageRef.current = onMessage;
    onOpenRef.current = onOpen;
    onCloseRef.current = onClose;
    onFatalCloseRef.current = onFatalClose;
  }, [onFatalClose, onClose, onMessage, onOpen]);

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
    let intentionalClose = false;
    const params = new URLSearchParams({
      participant_id: participantId,
      participant_token: participantToken
    });
    const socket = new WebSocket(`${WS_BASE_URL}/ws/rooms/${roomCode}?${params.toString()}`);
    socketRef.current = socket;

    socket.onopen = () => {
      onOpenRef.current?.();
      heartbeatRef.current = window.setInterval(() => {
        sendMessage({ type: "heartbeat", payload: { participant_id: participantId } });
      }, 10_000);
    };

    socket.onmessage = (event) => {
      onMessageRef.current(JSON.parse(event.data) as ServerSignalingMessage);
    };

    socket.onclose = (event) => {
      if (heartbeatRef.current !== null) {
        window.clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      if (intentionalClose) {
        return;
      }
      if ([4401, 4404, 4410].includes(event.code)) {
        onFatalCloseRef.current?.();
        return;
      }
      onCloseRef.current?.();
    };

    return () => {
      intentionalClose = true;
      if (heartbeatRef.current !== null) {
        window.clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      socket.close();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [enabled, participantId, participantToken, roomCode, sendMessage]);

  return { sendMessage };
}
