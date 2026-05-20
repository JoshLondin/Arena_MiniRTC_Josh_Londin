import type { Participant } from "../types/signaling";
import type { RoomState } from "./roomReducer";

export function selectActiveParticipants(state: RoomState): Participant[] {
  return state.participants.filter((participant) => participant.status === "ACTIVE");
}

export function selectActiveParticipantCount(state: RoomState): number {
  return selectActiveParticipants(state).length;
}

export function selectCurrentParticipant(state: RoomState): Participant | null {
  return (
    state.participants.find((participant) => participant.participant_id === state.participantId) ??
    null
  );
}

export function selectRemoteParticipant(state: RoomState): Participant | null {
  return (
    state.participants.find(
      (participant) =>
        participant.participant_id !== state.participantId && participant.status === "ACTIVE"
    ) ?? null
  );
}

export function selectCanStartCall(state: RoomState): boolean {
  return (
    state.connectionStatus === "connected" &&
    state.callStatus === "IDLE" &&
    selectActiveParticipantCount(state) === state.capacity
  );
}

export function selectCanJoinCall(state: RoomState): boolean {
  return (
    state.connectionStatus === "connected" &&
    state.callStatus === "CALL_PENDING" &&
    state.callHostParticipantId !== state.participantId &&
    state.localStream === null
  );
}

export function selectIsLastParticipant(state: RoomState): boolean {
  return state.reservedParticipantCount <= 1 && selectActiveParticipantCount(state) <= 1;
}
