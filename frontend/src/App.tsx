import { useCallback, useEffect, useMemo, useReducer, useState } from "react";

import { JoinRoomForm } from "./components/JoinRoomForm";
import { RoomPage } from "./components/RoomPage";
import { useMediaDevices } from "./hooks/useMediaDevices";
import { clearCredentials, loadCredentials, saveCredentials, useRoom } from "./hooks/useRoom";
import { useWebRTC } from "./hooks/useWebRTC";
import { useWebSocket } from "./hooks/useWebSocket";
import { initialRoomState, roomReducer } from "./state/roomReducer";
import type { MediaStatus } from "./state/roomReducer";
import type { ClientSignalingMessage, RoomCredentials, ServerSignalingMessage } from "./types/signaling";

function roomCodeFromPath(): string | null {
  const match = location.pathname.match(/^\/room\/([^/]+)$/);
  return match?.[1] ?? null;
}

export function App() {
  const requestedRoomCode = roomCodeFromPath();
  const roomApi = useRoom();
  const mediaDevices = useMediaDevices();
  const [credentials, setCredentials] = useState<RoomCredentials | null>(() =>
    loadCredentials(requestedRoomCode ?? undefined)
  );
  const [isSessionReady, setIsSessionReady] = useState(false);
  const [state, dispatch] = useReducer(
    roomReducer,
    credentials ?? {
      roomCode: requestedRoomCode ?? "",
      participantId: "",
      participantToken: "",
      username: ""
    },
    initialRoomState
  );

  const getIceServers = useCallback(async () => {
    if (!credentials) {
      return [];
    }
    return roomApi.iceServers(credentials);
  }, [credentials, roomApi]);

  const handleServerMessage = useCallback((message: ServerSignalingMessage) => {
    if (message.type === "room-state") {
      dispatch({ type: "ROOM_STATE_RECEIVED", payload: message.payload });
    }
    if (message.type === "participant-joined") {
      dispatch({ type: "PARTICIPANT_JOINED", payload: message.payload });
    }
    if (message.type === "participant-left") {
      dispatch({ type: "PARTICIPANT_LEFT", payload: message.payload });
    }
    if (message.type === "participant-disconnected") {
      dispatch({ type: "PARTICIPANT_DISCONNECTED", payload: message.payload });
    }
    if (message.type === "call-started") {
      dispatch({ type: "CALL_STARTED", payload: message.payload });
    }
    if (message.type === "call-joined") {
      dispatch({ type: "CALL_JOINED", payload: message.payload });
    }
    if (message.type === "call-ended") {
      dispatch({ type: "CALL_ENDED", payload: message.payload });
    }
    if (message.type === "room-deleted") {
      clearCredentials();
      dispatch({ type: "ROOM_DELETED", payload: message.payload });
    }
    if (message.type === "error") {
      dispatch({ type: "SET_ERROR", payload: message.payload.message });
    }
  }, []);

  const noopSend = useCallback((_message: ClientSignalingMessage) => undefined, []);
  const [sendMessage, setSendMessage] = useState<(message: ClientSignalingMessage) => void>(() => noopSend);

  const handleLocalStream = useCallback((stream: MediaStream | null) => {
    dispatch({ type: "SET_LOCAL_STREAM", payload: stream });
  }, []);

  const handleRemoteStream = useCallback((stream: MediaStream | null) => {
    dispatch({ type: "SET_REMOTE_STREAM", payload: stream });
  }, []);

  const handleMediaStatus = useCallback((status: MediaStatus) => {
    dispatch({ type: "SET_MEDIA_STATUS", payload: status });
  }, []);

  const handleMediaWarning = useCallback((warning: string | null) => {
    dispatch({ type: "SET_MEDIA_WARNING", payload: warning });
  }, []);

  const webRtc = useWebRTC({
    credentials: credentials ?? state,
    participants: state.participants,
    sendMessage,
    getIceServers,
    onLocalStream: handleLocalStream,
    onRemoteStream: handleRemoteStream,
    onMediaStatus: handleMediaStatus,
    onWarning: handleMediaWarning
  });

  const onMessage = useCallback(
    async (message: ServerSignalingMessage) => {
      handleServerMessage(message);
      if (message.type === "call-joined") {
        await webRtc.beginNegotiation(message.payload.call_host_participant_id);
      }
      if (message.type === "offer") {
        await webRtc.handleOffer(message.payload.sdp);
      }
      if (message.type === "answer") {
        await webRtc.handleAnswer(message.payload.sdp);
      }
      if (message.type === "ice-candidate") {
        await webRtc.handleIceCandidate(message.payload);
      }
      if (
        message.type === "call-ended" ||
        message.type === "room-deleted" ||
        (message.type === "participant-left" && message.payload.call_ended)
      ) {
        webRtc.cleanupPeerConnection();
        webRtc.stopMedia();
      }
    },
    [handleServerMessage, webRtc]
  );

  const handleSocketOpen = useCallback(() => {
    dispatch({ type: "SET_CONNECTION_STATUS", payload: "connected" });
  }, []);

  const handleSocketClose = useCallback(() => {
    dispatch({ type: "SET_CONNECTION_STATUS", payload: "reconnecting" });
  }, []);

  const handleSocketFatalClose = useCallback(() => {
    clearCredentials();
    setIsSessionReady(false);
    setCredentials(null);
    dispatch({ type: "SET_CONNECTION_STATUS", payload: "failed" });
  }, []);

  const socket = useWebSocket({
    roomCode: credentials?.roomCode ?? null,
    participantId: credentials?.participantId ?? null,
    participantToken: credentials?.participantToken ?? null,
    enabled: credentials !== null && isSessionReady,
    onMessage,
    onOpen: handleSocketOpen,
    onClose: handleSocketClose,
    onFatalClose: handleSocketFatalClose
  });

  useEffect(() => {
    setSendMessage(() => socket.sendMessage);
  }, [socket.sendMessage]);

  useEffect(() => {
    let cancelled = false;
    setIsSessionReady(false);
    if (!credentials) {
      return;
    }
    dispatch({ type: "BOOTSTRAP", payload: credentials });
    roomApi
      .reconnect(credentials)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.must_restart_peer_connection) {
          webRtc.cleanupPeerConnection();
          webRtc.stopMedia();
        }
        setIsSessionReady(true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        clearCredentials();
        setCredentials(null);
      });
    return () => {
      cancelled = true;
    };
  }, [credentials]);

  const create = useCallback(
    async (username: string) => {
      const nextCredentials = await roomApi.create(username);
      saveCredentials(nextCredentials);
      setIsSessionReady(false);
      setCredentials(nextCredentials);
      dispatch({ type: "BOOTSTRAP", payload: nextCredentials });
    },
    [roomApi]
  );

  const join = useCallback(
    async (username: string) => {
      if (!requestedRoomCode) {
        return;
      }
      const nextCredentials = await roomApi.join(requestedRoomCode, username);
      setIsSessionReady(false);
      setCredentials(nextCredentials);
      dispatch({ type: "BOOTSTRAP", payload: nextCredentials });
    },
    [requestedRoomCode, roomApi]
  );

  const prepareMedia = useCallback(async () => {
    dispatch({ type: "SET_MEDIA_STATUS", payload: "preparing" });
    const media = await mediaDevices.getCallMedia();
    webRtc.attachLocalStream(media.stream, media.warning);
  }, [mediaDevices, webRtc]);

  const startCall = useCallback(async () => {
    try {
      await prepareMedia();
      socket.sendMessage({ type: "start-call", payload: { participant_id: state.participantId } });
    } catch (error) {
      dispatch({ type: "SET_MEDIA_STATUS", payload: "failed" });
      dispatch({ type: "SET_ERROR", payload: error instanceof Error ? error.message : "Media failed." });
    }
  }, [prepareMedia, socket, state.participantId]);

  const joinCall = useCallback(async () => {
    try {
      await prepareMedia();
      socket.sendMessage({ type: "join-call", payload: { participant_id: state.participantId } });
    } catch (error) {
      dispatch({ type: "SET_MEDIA_STATUS", payload: "failed" });
      dispatch({ type: "SET_ERROR", payload: error instanceof Error ? error.message : "Media failed." });
    }
  }, [prepareMedia, socket, state.participantId]);

  const leaveCall = useCallback(() => {
    socket.sendMessage({ type: "end-call", payload: { participant_id: state.participantId } });
    webRtc.cleanupPeerConnection();
    webRtc.stopMedia();
  }, [socket, state.participantId, webRtc]);

  const leaveCurrentRoom = useCallback(async () => {
    if (!credentials) {
      return;
    }
    const activeParticipantCount = state.participants.filter((participant) => participant.status === "ACTIVE").length;
    const isFinalParticipant = state.reservedParticipantCount <= 1 && activeParticipantCount <= 1;
    if (isFinalParticipant) {
      const confirmed = confirm("You're the last person in the room. Leaving it will close the room.");
      if (!confirmed) {
        return;
      }
    }
    await roomApi.leave(credentials);
    webRtc.cleanupPeerConnection();
    webRtc.stopMedia();
    setIsSessionReady(false);
    setCredentials(null);
    history.pushState(null, "", "/");
  }, [credentials, roomApi, state.reservedParticipantCount, webRtc]);

  const roomPage = useMemo(() => {
    if (!credentials) {
      return null;
    }
    return (
      <RoomPage
        state={state}
        onStartCall={startCall}
        onJoinCall={joinCall}
        onLeaveCall={leaveCall}
        onLeaveRoom={leaveCurrentRoom}
        onToggleMute={() => dispatch({ type: "SET_MUTED", payload: !state.isMuted })}
        onToggleCamera={() => dispatch({ type: "SET_CAMERA_ENABLED", payload: !state.isCameraEnabled })}
      />
    );
  }, [credentials, joinCall, leaveCall, leaveCurrentRoom, startCall, state]);

  if (roomPage) {
    return roomPage;
  }

  if (requestedRoomCode) {
    return <JoinRoomForm mode="join" roomCode={requestedRoomCode} onSubmit={join} />;
  }

  return <JoinRoomForm mode="create" onSubmit={create} />;
}
