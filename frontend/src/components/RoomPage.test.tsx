import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoomState } from "../state/roomReducer";
import { RoomPage } from "./RoomPage";

afterEach(() => {
  cleanup();
});

function makeRoomState(overrides: Partial<RoomState> = {}): RoomState {
  return {
    roomCode: "ROOM12345678",
    roomName: "Interview Prep",
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

function renderRoom(state: RoomState) {
  return render(
    <RoomPage
      state={state}
      onStartCall={vi.fn()}
      onJoinCall={vi.fn()}
      onLeaveCall={vi.fn()}
      onLeaveRoom={vi.fn()}
      onToggleMute={vi.fn()}
      onToggleCamera={vi.fn()}
    />
  );
}

const fakeLocalStream = {
  getVideoTracks: () => []
} as unknown as MediaStream;

describe("RoomPage video labels", () => {
  it("shows the room name in the page header", () => {
    renderRoom(makeRoomState());

    expect(screen.getByRole("heading", { name: "Interview Prep" })).toBeTruthy();
  });

  it("centers participant names before the call starts", () => {
    renderRoom(makeRoomState());

    expect(screen.getAllByText("Alice").some((element) => element.className.includes("video-panel-name"))).toBe(
      true
    );
    expect(screen.getAllByText("Bob").some((element) => element.className.includes("video-panel-name"))).toBe(
      true
    );
  });

  it("shows that the remote participant is in the call before the current user joins", () => {
    renderRoom(
      makeRoomState({
        callStatus: "CALL_PENDING",
        roomStatus: "CALL_PENDING",
        callHostParticipantId: "bob-id",
        participantMediaStates: {
          "bob-id": { isMuted: true, isCameraEnabled: false }
        }
      })
    );

    expect(screen.getAllByText("Alice").some((element) => element.className.includes("video-panel-name"))).toBe(
      true
    );
    expect(screen.getByText("Bob is in the call").className).toContain("video-panel-name");
    expect(screen.queryByLabelText("Audio muted")).toBeNull();
  });

  it("keeps a centered waiting label after the current user starts the call", () => {
    renderRoom(
      makeRoomState({
        callStatus: "CALL_PENDING",
        roomStatus: "CALL_PENDING",
        callHostParticipantId: "alice-id",
        localStream: fakeLocalStream,
        mediaStatus: "connecting"
      })
    );

    expect(screen.getByText("Bob has not joined the call").className).toContain("video-panel-name");
    expect(screen.queryByText("Bob is in the call")).toBeNull();
  });
});
