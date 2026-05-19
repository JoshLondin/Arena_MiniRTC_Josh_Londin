export type RoomStatus =
  | "EMPTY"
  | "WAITING_FOR_PARTICIPANT"
  | "READY_FOR_CALL"
  | "CALL_PENDING"
  | "NEGOTIATING"
  | "IN_CALL";

export type CallStatus = "IDLE" | "CALL_PENDING" | "NEGOTIATING" | "IN_CALL";
export type ParticipantStatus = "ACTIVE" | "DISCONNECTED";

export type Participant = {
  participant_id: string;
  username: string;
  status: ParticipantStatus;
  is_room_host?: boolean;
};

export type RoomStatePayload = {
  room_status: RoomStatus;
  reserved_participant_count: number;
  capacity: 2;
  participants: Participant[];
  call_status: CallStatus;
  call_host_participant_id: string | null;
};

export type ClientSignalingMessage =
  | { type: "heartbeat"; payload: { participant_id?: string } }
  | { type: "start-call"; payload: { participant_id?: string } }
  | { type: "join-call"; payload: { participant_id?: string } }
  | { type: "end-call"; payload: { participant_id?: string } }
  | { type: "media-connected"; payload: { participant_id?: string } }
  | { type: "offer"; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: "answer"; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: "ice-candidate"; payload: RTCIceCandidateInit };

export type ServerSignalingMessage =
  | { type: "room-state"; payload: RoomStatePayload }
  | {
      type: "participant-joined";
      payload: { participant_id: string; username: string; reserved_participant_count: number };
    }
  | {
      type: "participant-left";
      payload: { participant_id: string; reserved_participant_count: number; call_ended: boolean };
    }
  | {
      type: "participant-disconnected";
      payload: { participant_id: string; reconnect_timeout_seconds: number };
    }
  | {
      type: "participant-reconnected";
      payload: { participant_id: string; must_restart_peer_connection: boolean };
    }
  | {
      type: "call-started";
      payload: { call_host_participant_id: string; message: string };
    }
  | {
      type: "call-joined";
      payload: { call_host_participant_id: string; room_status: "NEGOTIATING" };
    }
  | {
      type: "call-ended";
      payload: {
        reason:
          | "HOST_ENDED"
          | "PARTICIPANT_LEFT_CALL"
          | "PARTICIPANT_LEFT_ROOM"
          | "RECONNECT_TIMEOUT"
          | "ROOM_DELETED";
      };
    }
  | { type: "room-deleted"; payload: { reason: "EMPTY_ROOM" | "HOST_DELETED" } }
  | { type: "error"; payload: { code: string; message: string } }
  | { type: "offer"; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: "answer"; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: "ice-candidate"; payload: RTCIceCandidateInit };

export type RoomCredentials = {
  roomCode: string;
  participantId: string;
  participantToken: string;
  hostToken?: string;
  username: string;
};

