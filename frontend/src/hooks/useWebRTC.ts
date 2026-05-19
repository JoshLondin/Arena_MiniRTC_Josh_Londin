import { useCallback, useRef } from "react";

import type { ClientSignalingMessage, Participant, RoomCredentials } from "../types/signaling";

type UseWebRTCOptions = {
  credentials: RoomCredentials;
  participants: Participant[];
  sendMessage: (message: ClientSignalingMessage) => void;
  getIceServers: () => Promise<RTCIceServer[]>;
  onLocalStream: (stream: MediaStream | null) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
  onConnectionState: (state: "idle" | "connecting" | "connected" | "reconnecting" | "failed") => void;
  onWarning: (warning: string | null) => void;
};

export function useWebRTC({
  credentials,
  participants,
  sendMessage,
  getIceServers,
  onLocalStream,
  onRemoteStream,
  onConnectionState,
  onWarning
}: UseWebRTCOptions) {
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  const cleanupPeerConnection = useCallback(() => {
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    pendingCandidatesRef.current = [];
    onConnectionState("idle");
  }, [onConnectionState]);

  const stopMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    onLocalStream(null);
    onRemoteStream(null);
  }, [onLocalStream, onRemoteStream]);

  const attachLocalStream = useCallback(
    (stream: MediaStream, warning: string | null) => {
      localStreamRef.current = stream;
      onLocalStream(stream);
      onWarning(warning);
    },
    [onLocalStream, onWarning]
  );

  const createPeerConnection = useCallback(async () => {
    cleanupPeerConnection();
    const iceServers = await getIceServers();
    const peerConnection = new RTCPeerConnection({ iceServers });
    const remoteStream = new MediaStream();
    onRemoteStream(remoteStream);
    localStreamRef.current?.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStreamRef.current as MediaStream);
    });
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        sendMessage({ type: "ice-candidate", payload: event.candidate.toJSON() });
      }
    };
    peerConnection.ontrack = (event) => {
      event.streams[0]?.getTracks().forEach((track) => remoteStream.addTrack(track));
      onRemoteStream(remoteStream);
    };
    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === "connected") {
        onConnectionState("connected");
        sendMessage({ type: "media-connected", payload: { participant_id: credentials.participantId } });
      }
      if (peerConnection.connectionState === "failed") {
        onConnectionState("failed");
        cleanupPeerConnection();
      }
    };
    peerConnection.oniceconnectionstatechange = () => {
      if (["connected", "completed"].includes(peerConnection.iceConnectionState)) {
        onConnectionState("connected");
        sendMessage({ type: "media-connected", payload: { participant_id: credentials.participantId } });
      }
      if (peerConnection.iceConnectionState === "failed") {
        onConnectionState("failed");
        cleanupPeerConnection();
      }
    };
    peerConnectionRef.current = peerConnection;
    onConnectionState("connecting");
    return peerConnection;
  }, [cleanupPeerConnection, credentials.participantId, getIceServers, onConnectionState, onRemoteStream, sendMessage]);

  const isInitiator = useCallback(() => {
    const activeIds = participants
      .filter((participant) => participant.status === "ACTIVE")
      .map((participant) => participant.participant_id)
      .sort();
    return activeIds[0] === credentials.participantId;
  }, [credentials.participantId, participants]);

  const beginNegotiation = useCallback(async () => {
    const peerConnection = await createPeerConnection();
    if (!isInitiator()) {
      return;
    }
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendMessage({ type: "offer", payload: { sdp: offer } });
  }, [createPeerConnection, isInitiator, sendMessage]);

  const handleOffer = useCallback(
    async (sdp: RTCSessionDescriptionInit) => {
      const peerConnection = peerConnectionRef.current ?? (await createPeerConnection());
      if (isInitiator() && peerConnection.signalingState !== "stable") {
        return;
      }
      await peerConnection.setRemoteDescription(sdp);
      for (const candidate of pendingCandidatesRef.current) {
        await peerConnection.addIceCandidate(candidate);
      }
      pendingCandidatesRef.current = [];
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      sendMessage({ type: "answer", payload: { sdp: answer } });
    },
    [createPeerConnection, isInitiator, sendMessage]
  );

  const handleAnswer = useCallback(async (sdp: RTCSessionDescriptionInit) => {
    const peerConnection = peerConnectionRef.current;
    if (!peerConnection) {
      return;
    }
    await peerConnection.setRemoteDescription(sdp);
    for (const candidate of pendingCandidatesRef.current) {
      await peerConnection.addIceCandidate(candidate);
    }
    pendingCandidatesRef.current = [];
  }, []);

  const handleIceCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    const peerConnection = peerConnectionRef.current;
    if (!peerConnection?.remoteDescription) {
      pendingCandidatesRef.current.push(candidate);
      return;
    }
    await peerConnection.addIceCandidate(candidate);
  }, []);

  return {
    attachLocalStream,
    beginNegotiation,
    cleanupPeerConnection,
    stopMedia,
    handleOffer,
    handleAnswer,
    handleIceCandidate
  };
}

