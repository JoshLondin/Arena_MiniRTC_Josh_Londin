import { useCallback, useEffect, useMemo, useRef } from "react";

import type { MediaStatus } from "../state/roomReducer";
import type { ClientSignalingMessage, Participant, RoomCredentials } from "../types/signaling";

type UseWebRTCOptions = {
  credentials: RoomCredentials;
  participants: Participant[];
  sendMessage: (message: ClientSignalingMessage) => void;
  getIceServers: () => Promise<RTCIceServer[]>;
  onLocalStream: (stream: MediaStream | null) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
  onMediaStatus: (state: MediaStatus) => void;
  onWarning: (warning: string | null) => void;
};

export function useWebRTC({
  credentials,
  participants,
  sendMessage,
  getIceServers,
  onLocalStream,
  onRemoteStream,
  onMediaStatus,
  onWarning
}: UseWebRTCOptions) {
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const sentMediaConnectedRef = useRef(false);
  const credentialsRef = useRef(credentials);
  const participantsRef = useRef(participants);
  const sendMessageRef = useRef(sendMessage);
  const getIceServersRef = useRef(getIceServers);
  const onLocalStreamRef = useRef(onLocalStream);
  const onRemoteStreamRef = useRef(onRemoteStream);
  const onMediaStatusRef = useRef(onMediaStatus);
  const onWarningRef = useRef(onWarning);

  useEffect(() => {
    credentialsRef.current = credentials;
    participantsRef.current = participants;
    sendMessageRef.current = sendMessage;
    getIceServersRef.current = getIceServers;
    onLocalStreamRef.current = onLocalStream;
    onRemoteStreamRef.current = onRemoteStream;
    onMediaStatusRef.current = onMediaStatus;
    onWarningRef.current = onWarning;
  }, [
    credentials,
    getIceServers,
    onLocalStream,
    onMediaStatus,
    onRemoteStream,
    onWarning,
    participants,
    sendMessage
  ]);

  const sendMediaConnected = useCallback(() => {
    if (sentMediaConnectedRef.current) {
      return;
    }
    sentMediaConnectedRef.current = true;
    sendMessageRef.current({
      type: "media-connected",
      payload: { participant_id: credentialsRef.current.participantId }
    });
  }, []);

  const cleanupPeerConnection = useCallback((nextStatus: MediaStatus = "idle") => {
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    videoSenderRef.current = null;
    remoteStreamRef.current = null;
    pendingCandidatesRef.current = [];
    sentMediaConnectedRef.current = false;
    onRemoteStreamRef.current(null);
    onMediaStatusRef.current(nextStatus);
  }, []);

  const stopMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    videoSenderRef.current = null;
    onLocalStreamRef.current(null);
    onWarningRef.current(null);
  }, []);

  const attachLocalStream = useCallback((stream: MediaStream, warning: string | null) => {
    localStreamRef.current = stream;
    onLocalStreamRef.current(stream);
    onWarningRef.current(warning);
    onMediaStatusRef.current("connecting");
    const peerConnection = peerConnectionRef.current;
    if (peerConnection) {
      stream.getTracks().forEach((track) => {
        const alreadyAdded = peerConnection
          .getSenders()
          .some((sender) => sender.track?.id === track.id);
        if (!alreadyAdded) {
          const sender = peerConnection.addTrack(track, stream);
          if (track.kind === "video") {
            videoSenderRef.current = sender;
          }
        }
      });
    }
  }, []);

  const disableCamera = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream) {
      return;
    }
    const videoTracks = stream.getVideoTracks();
    await videoSenderRef.current?.replaceTrack(null);
    videoTracks.forEach((track) => {
      stream.removeTrack(track);
      track.stop();
    });
    onLocalStreamRef.current(new MediaStream(stream.getTracks()));
  }, []);

  const enableCamera = useCallback(async (track: MediaStreamTrack) => {
    let stream = localStreamRef.current;
    if (!stream) {
      stream = new MediaStream();
      localStreamRef.current = stream;
    }
    stream.getVideoTracks().forEach((existingTrack) => {
      stream.removeTrack(existingTrack);
      existingTrack.stop();
    });
    stream.addTrack(track);
    const peerConnection = peerConnectionRef.current;
    if (peerConnection) {
      if (videoSenderRef.current) {
        await videoSenderRef.current.replaceTrack(track);
      } else {
        videoSenderRef.current = peerConnection.addTrack(track, stream);
      }
    }
    onLocalStreamRef.current(new MediaStream(stream.getTracks()));
  }, []);

  const flushPendingCandidates = useCallback(async (peerConnection: RTCPeerConnection) => {
    for (const candidate of pendingCandidatesRef.current) {
      await peerConnection.addIceCandidate(candidate);
    }
    pendingCandidatesRef.current = [];
  }, []);

  const createPeerConnection = useCallback(async () => {
    cleanupPeerConnection("connecting");
    const iceServers = await getIceServersRef.current();
    const peerConnection = new RTCPeerConnection({ iceServers });
    const remoteStream = new MediaStream();
    remoteStreamRef.current = remoteStream;
    onRemoteStreamRef.current(remoteStream);

    localStreamRef.current?.getTracks().forEach((track) => {
      const sender = peerConnection.addTrack(track, localStreamRef.current as MediaStream);
      if (track.kind === "video") {
        videoSenderRef.current = sender;
      }
    });

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        sendMessageRef.current({ type: "ice-candidate", payload: event.candidate.toJSON() });
      }
    };

    peerConnection.ontrack = (event) => {
      const nextRemoteStream = remoteStreamRef.current ?? new MediaStream();
      if (!remoteStreamRef.current) {
        remoteStreamRef.current = nextRemoteStream;
      }
      if (!nextRemoteStream.getTracks().some((track) => track.id === event.track.id)) {
        nextRemoteStream.addTrack(event.track);
      }
      onRemoteStreamRef.current(nextRemoteStream);
    };

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === "connected") {
        onMediaStatusRef.current("connected");
        sendMediaConnected();
      }
      if (peerConnection.connectionState === "failed") {
        cleanupPeerConnection("failed");
      }
      if (peerConnection.connectionState === "disconnected") {
        onMediaStatusRef.current("connecting");
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      if (["connected", "completed"].includes(peerConnection.iceConnectionState)) {
        onMediaStatusRef.current("connected");
        sendMediaConnected();
      }
      if (peerConnection.iceConnectionState === "failed") {
        cleanupPeerConnection("failed");
      }
    };

    peerConnectionRef.current = peerConnection;
    onMediaStatusRef.current("connecting");
    return peerConnection;
  }, [cleanupPeerConnection, sendMediaConnected]);

  const beginNegotiation = useCallback(
    async (callHostParticipantId: string | null) => {
      const peerConnection = await createPeerConnection();
      if (callHostParticipantId !== credentialsRef.current.participantId) {
        return;
      }
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      sendMessageRef.current({ type: "offer", payload: { sdp: offer } });
    },
    [createPeerConnection]
  );

  const handleOffer = useCallback(
    async (sdp: RTCSessionDescriptionInit) => {
      const peerConnection = peerConnectionRef.current ?? (await createPeerConnection());
      await peerConnection.setRemoteDescription(sdp);
      await flushPendingCandidates(peerConnection);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      sendMessageRef.current({ type: "answer", payload: { sdp: answer } });
    },
    [createPeerConnection, flushPendingCandidates]
  );

  const handleAnswer = useCallback(
    async (sdp: RTCSessionDescriptionInit) => {
      const peerConnection = peerConnectionRef.current;
      if (!peerConnection) {
        return;
      }
      await peerConnection.setRemoteDescription(sdp);
      await flushPendingCandidates(peerConnection);
    },
    [flushPendingCandidates]
  );

  const handleIceCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    const peerConnection = peerConnectionRef.current;
    if (!peerConnection?.remoteDescription) {
      pendingCandidatesRef.current.push(candidate);
      return;
    }
    await peerConnection.addIceCandidate(candidate);
  }, []);

  return useMemo(
    () => ({
      attachLocalStream,
      disableCamera,
      enableCamera,
      beginNegotiation,
      cleanupPeerConnection,
      stopMedia,
      handleOffer,
      handleAnswer,
      handleIceCandidate
    }),
    [
      attachLocalStream,
      beginNegotiation,
      cleanupPeerConnection,
      disableCamera,
      enableCamera,
      handleAnswer,
      handleIceCandidate,
      handleOffer,
      stopMedia
    ]
  );
}
