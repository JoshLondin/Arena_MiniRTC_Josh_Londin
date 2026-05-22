import { describe, expect, it } from "vitest";

import { initialRoomState, roomReducer } from "./roomReducer";

function makeRoomState() {
  return {
    ...initialRoomState({
      roomCode: "ROOM12345678",
      participantId: "alice-id",
      participantToken: "alice-token",
      username: "Alice"
    }),
    participants: [
      { participant_id: "alice-id", username: "Alice", status: "ACTIVE" as const },
      { participant_id: "bob-id", username: "Bob", status: "ACTIVE" as const }
    ],
    reservedParticipantCount: 2
  };
}

describe("room reducer participant media state", () => {
  it("stores remote participant media state", () => {
    const nextState = roomReducer(makeRoomState(), {
      type: "PARTICIPANT_MEDIA_STATE",
      payload: {
        participant_id: "bob-id",
        is_muted: true,
        is_camera_enabled: false
      }
    });

    expect(nextState.participantMediaStates["bob-id"]).toEqual({
      isMuted: true,
      isCameraEnabled: false
    });
  });

  it("removes media state when a participant leaves", () => {
    const state = {
      ...makeRoomState(),
      participantMediaStates: {
        "bob-id": { isMuted: true, isCameraEnabled: false },
        "carol-id": { isMuted: false, isCameraEnabled: true }
      }
    };

    const nextState = roomReducer(state, {
      type: "PARTICIPANT_LEFT",
      payload: {
        participant_id: "bob-id",
        reserved_participant_count: 1,
        call_ended: false
      }
    });

    expect(nextState.participantMediaStates["bob-id"]).toBeUndefined();
    expect(nextState.participantMediaStates["carol-id"]).toEqual({
      isMuted: false,
      isCameraEnabled: true
    });
  });

  it("clears media state when the call ends", () => {
    const state = {
      ...makeRoomState(),
      isMuted: true,
      isCameraEnabled: false,
      participantMediaStates: {
        "bob-id": { isMuted: true, isCameraEnabled: false }
      }
    };

    const nextState = roomReducer(state, {
      type: "CALL_ENDED",
      payload: { reason: "HOST_ENDED" }
    });

    expect(nextState.participantMediaStates).toEqual({});
    expect(nextState.isMuted).toBe(false);
    expect(nextState.isCameraEnabled).toBe(true);
  });

  it("resets local media controls when a participant leaves and ends the call", () => {
    const state = {
      ...makeRoomState(),
      isMuted: true,
      isCameraEnabled: false,
      callStatus: "IN_CALL" as const,
      participantMediaStates: {
        "bob-id": { isMuted: true, isCameraEnabled: true }
      }
    };

    const nextState = roomReducer(state, {
      type: "PARTICIPANT_LEFT",
      payload: {
        participant_id: "bob-id",
        reserved_participant_count: 1,
        call_ended: true
      }
    });

    expect(nextState.callStatus).toBe("IDLE");
    expect(nextState.isMuted).toBe(false);
    expect(nextState.isCameraEnabled).toBe(true);
    expect(nextState.participantMediaStates).toEqual({});
  });

  it("removes a disconnected participant media state", () => {
    const state = {
      ...makeRoomState(),
      participantMediaStates: {
        "bob-id": { isMuted: true, isCameraEnabled: false }
      }
    };

    const nextState = roomReducer(state, {
      type: "PARTICIPANT_DISCONNECTED",
      payload: { participant_id: "bob-id" }
    });

    expect(nextState.participantMediaStates).toEqual({});
  });

  it("prunes stale media state when room state changes participants", () => {
    const state = {
      ...makeRoomState(),
      participantMediaStates: {
        "bob-id": { isMuted: true, isCameraEnabled: false }
      }
    };

    const nextState = roomReducer(state, {
      type: "ROOM_STATE_RECEIVED",
      payload: {
        room_status: "WAITING_FOR_PARTICIPANT",
        reserved_participant_count: 1,
        capacity: 2,
        participants: [{ participant_id: "alice-id", username: "Alice", status: "ACTIVE" }],
        call_status: "IDLE",
        call_host_participant_id: null
      }
    });

    expect(nextState.participantMediaStates).toEqual({});
  });

  it("clears stale media state when room state restarts a call as pending", () => {
    const state = {
      ...makeRoomState(),
      callStatus: "IN_CALL" as const,
      participantMediaStates: {
        "bob-id": { isMuted: true, isCameraEnabled: false }
      }
    };

    const nextState = roomReducer(state, {
      type: "ROOM_STATE_RECEIVED",
      payload: {
        room_status: "CALL_PENDING",
        reserved_participant_count: 2,
        capacity: 2,
        participants: state.participants,
        call_status: "CALL_PENDING",
        call_host_participant_id: "alice-id"
      }
    });

    expect(nextState.participantMediaStates).toEqual({});
    expect(nextState.callStatus).toBe("CALL_PENDING");
  });
});
