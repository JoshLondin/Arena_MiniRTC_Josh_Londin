import { describe, expect, it } from "vitest";

import type { RoomState } from "./roomReducer";
import {
  selectActiveParticipantCount,
  selectCanJoinCall,
  selectCanStartCall,
  selectCurrentParticipant,
  selectIsLastParticipant,
  selectRemoteParticipant
} from "./roomSelectors";

function makeRoomState(overrides: Partial<RoomState> = {}): RoomState {
  return {
    roomCode: "ROOM12345678",
    participantId: "alice-id",
    participantToken: "alice-token",
    username: "Alice",
    reservedParticipantCount: 2,
    capacity: 2,
    roomStatus: "READY_FOR_CALL",
    callStatus: "IDLE",
    callHostParticipantId: null,
    participants: [
      { participant_id: "alice-id", username: "Alice", status: "ACTIVE" },
      { participant_id: "bob-id", username: "Bob", status: "ACTIVE" }
    ],
    connectionStatus: "connected",
    mediaStatus: "idle",
    isMuted: false,
    isCameraEnabled: true,
    participantMediaStates: {},
    localStream: null,
    remoteStream: null,
    mediaWarning: null,
    error: null,
    ...overrides
  };
}

describe("room selectors", () => {
  it("derives active participant count and current participant", () => {
    const state = makeRoomState({
      participants: [
        { participant_id: "alice-id", username: "Alice", status: "ACTIVE" },
        { participant_id: "bob-id", username: "Bob", status: "DISCONNECTED" }
      ]
    });

    expect(selectActiveParticipantCount(state)).toBe(1);
    expect(selectCurrentParticipant(state)?.username).toBe("Alice");
  });

  it("derives a remote participant only when another active participant exists", () => {
    expect(selectRemoteParticipant(makeRoomState())?.username).toBe("Bob");
    expect(
      selectRemoteParticipant(
        makeRoomState({
          participants: [
            { participant_id: "alice-id", username: "Alice", status: "ACTIVE" },
            { participant_id: "bob-id", username: "Bob", status: "DISCONNECTED" }
          ]
        })
      )
    ).toBeNull();
  });

  it("derives call actions from connection, participant, and call state", () => {
    expect(selectCanStartCall(makeRoomState())).toBe(true);
    expect(
      selectCanStartCall(
        makeRoomState({
          participants: [{ participant_id: "alice-id", username: "Alice", status: "ACTIVE" }]
        })
      )
    ).toBe(false);
    expect(
      selectCanJoinCall(
        makeRoomState({
          callStatus: "CALL_PENDING",
          callHostParticipantId: "bob-id"
        })
      )
    ).toBe(true);
    expect(
      selectCanJoinCall(
        makeRoomState({
          callStatus: "CALL_PENDING",
          callHostParticipantId: "alice-id"
        })
      )
    ).toBe(false);
  });

  it("derives final participant state from active and reserved counts", () => {
    expect(
      selectIsLastParticipant(
        makeRoomState({
          reservedParticipantCount: 1,
          participants: [{ participant_id: "alice-id", username: "Alice", status: "ACTIVE" }]
        })
      )
    ).toBe(true);
    expect(
      selectIsLastParticipant(
        makeRoomState({
          reservedParticipantCount: 2,
          participants: [{ participant_id: "alice-id", username: "Alice", status: "ACTIVE" }]
        })
      )
    ).toBe(false);
  });
});
