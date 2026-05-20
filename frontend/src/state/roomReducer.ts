import type { Participant, RoomCredentials, RoomStatePayload } from "../types/signaling";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "failed";
export type MediaStatus = "idle" | "preparing" | "connecting" | "connected" | "failed";

export type RoomState = {
  roomCode: string;
  participantId: string;
  participantToken: string;
  hostToken?: string;
  username: string;
  reservedParticipantCount: number;
  capacity: 2;
  roomStatus: RoomStatePayload["room_status"];
  callStatus: RoomStatePayload["call_status"];
  callHostParticipantId: string | null;
  participants: Participant[];
  connectionStatus: ConnectionStatus;
  mediaStatus: MediaStatus;
  isMuted: boolean;
  isCameraEnabled: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  mediaWarning: string | null;
  error: string | null;
};

export type RoomAction =
  | { type: "BOOTSTRAP"; payload: RoomCredentials }
  | { type: "ROOM_STATE_RECEIVED"; payload: RoomStatePayload }
  | {
      type: "PARTICIPANT_JOINED";
      payload: { participant_id: string; username: string; reserved_participant_count: number };
    }
  | {
      type: "PARTICIPANT_LEFT";
      payload: { participant_id: string; reserved_participant_count: number; call_ended?: boolean };
    }
  | { type: "PARTICIPANT_DISCONNECTED"; payload: { participant_id: string } }
  | { type: "CALL_STARTED"; payload: { call_host_participant_id: string; message: string } }
  | { type: "CALL_JOINED"; payload: { call_host_participant_id: string; room_status: "NEGOTIATING" } }
  | { type: "CALL_ENDED"; payload: { reason: string } }
  | { type: "ROOM_DELETED"; payload: { reason: string } }
  | { type: "SET_CONNECTION_STATUS"; payload: ConnectionStatus }
  | { type: "SET_MEDIA_STATUS"; payload: MediaStatus }
  | { type: "SET_MUTED"; payload: boolean }
  | { type: "SET_CAMERA_ENABLED"; payload: boolean }
  | { type: "SET_LOCAL_STREAM"; payload: MediaStream | null }
  | { type: "SET_REMOTE_STREAM"; payload: MediaStream | null }
  | { type: "SET_MEDIA_WARNING"; payload: string | null }
  | { type: "SET_ERROR"; payload: string | null };

export function initialRoomState(credentials: RoomCredentials): RoomState {
  return {
    roomCode: credentials.roomCode,
    participantId: credentials.participantId,
    participantToken: credentials.participantToken,
    hostToken: credentials.hostToken,
    username: credentials.username,
    reservedParticipantCount: 1,
    capacity: 2,
    roomStatus: "WAITING_FOR_PARTICIPANT",
    callStatus: "IDLE",
    callHostParticipantId: null,
    participants: credentials.participantId
      ? [
          {
            participant_id: credentials.participantId,
            username: credentials.username,
            status: "ACTIVE"
          }
        ]
      : [],
    connectionStatus: "idle",
    mediaStatus: "idle",
    isMuted: false,
    isCameraEnabled: true,
    localStream: null,
    remoteStream: null,
    mediaWarning: null,
    error: null
  };
}

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case "BOOTSTRAP":
      return initialRoomState(action.payload);
    case "ROOM_STATE_RECEIVED":
      return {
        ...state,
        roomStatus: action.payload.room_status,
        reservedParticipantCount: action.payload.reserved_participant_count,
        capacity: action.payload.capacity,
        participants: action.payload.participants,
        callStatus: action.payload.call_status,
        callHostParticipantId: action.payload.call_host_participant_id,
        error: null
      };
    case "PARTICIPANT_JOINED": {
      const hasParticipant = state.participants.some(
        (participant) => participant.participant_id === action.payload.participant_id
      );
      const participants = hasParticipant
        ? state.participants.map((participant) =>
            participant.participant_id === action.payload.participant_id
              ? { ...participant, username: action.payload.username, status: "ACTIVE" as const }
              : participant
          )
        : [
            ...state.participants,
            {
              participant_id: action.payload.participant_id,
              username: action.payload.username,
              status: "ACTIVE" as const
            }
          ];
      return {
        ...state,
        participants,
        reservedParticipantCount: action.payload.reserved_participant_count,
        error: null
      };
    }
    case "PARTICIPANT_LEFT":
      return {
        ...state,
        participants: state.participants.filter(
          (participant) => participant.participant_id !== action.payload.participant_id
        ),
        reservedParticipantCount: action.payload.reserved_participant_count,
        callStatus: action.payload.call_ended ? "IDLE" : state.callStatus,
        callHostParticipantId: action.payload.call_ended ? null : state.callHostParticipantId,
        mediaStatus: action.payload.call_ended ? "idle" : state.mediaStatus,
        localStream: action.payload.call_ended ? null : state.localStream,
        remoteStream: action.payload.call_ended ? null : state.remoteStream
      };
    case "PARTICIPANT_DISCONNECTED":
      return {
        ...state,
        participants: state.participants.map((participant) =>
          participant.participant_id === action.payload.participant_id
            ? { ...participant, status: "DISCONNECTED" }
            : participant
        )
      };
    case "CALL_STARTED":
      return {
        ...state,
        callStatus: "CALL_PENDING",
        roomStatus: "CALL_PENDING",
        callHostParticipantId: action.payload.call_host_participant_id,
        error: null
      };
    case "CALL_JOINED":
      return {
        ...state,
        callStatus: "NEGOTIATING",
        roomStatus: action.payload.room_status,
        callHostParticipantId: action.payload.call_host_participant_id,
        mediaStatus: "connecting"
      };
    case "CALL_ENDED":
      state.localStream?.getTracks().forEach((track) => track.stop());
      state.remoteStream?.getTracks().forEach((track) => track.stop());
      return {
        ...state,
        callStatus: "IDLE",
        callHostParticipantId: null,
        mediaStatus: "idle",
        localStream: null,
        remoteStream: null
      };
    case "ROOM_DELETED":
      return {
        ...state,
        error: "This room was deleted.",
        connectionStatus: "failed",
        mediaStatus: "idle",
        localStream: null,
        remoteStream: null
      };
    case "SET_CONNECTION_STATUS":
      return { ...state, connectionStatus: action.payload };
    case "SET_MEDIA_STATUS":
      return { ...state, mediaStatus: action.payload };
    case "SET_MUTED":
      state.localStream?.getAudioTracks().forEach((track) => {
        track.enabled = !action.payload;
      });
      return { ...state, isMuted: action.payload };
    case "SET_CAMERA_ENABLED":
      state.localStream?.getVideoTracks().forEach((track) => {
        track.enabled = action.payload;
      });
      return { ...state, isCameraEnabled: action.payload };
    case "SET_LOCAL_STREAM":
      return { ...state, localStream: action.payload };
    case "SET_REMOTE_STREAM":
      return { ...state, remoteStream: action.payload };
    case "SET_MEDIA_WARNING":
      return { ...state, mediaWarning: action.payload };
    case "SET_ERROR":
      return { ...state, error: action.payload };
    default:
      return state;
  }
}
