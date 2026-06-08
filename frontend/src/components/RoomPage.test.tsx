import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  const onRenameRoom = vi.fn().mockResolvedValue(undefined);
  return render(
    <RoomPage
      state={state}
      onStartCall={vi.fn()}
      onJoinCall={vi.fn()}
      onLeaveCall={vi.fn()}
      onLeaveRoom={vi.fn()}
      onToggleMute={vi.fn()}
      onToggleCamera={vi.fn()}
      onRenameRoom={onRenameRoom}
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

  it("shows rename controls only for the host", () => {
    const hostRender = renderRoom(makeRoomState({ hostToken: "host-token" }));

    expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();

    hostRender.unmount();
    renderRoom(makeRoomState({ hostToken: undefined }));

    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("rejects blank room names before saving", async () => {
    renderRoom(makeRoomState({ hostToken: "host-token" }));

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Room name"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Room name cannot be blank.")).toBeTruthy();
  });

  it("saves a host room rename", async () => {
    const onRenameRoom = vi.fn().mockResolvedValue(undefined);
    render(
      <RoomPage
        state={makeRoomState({ hostToken: "host-token" })}
        onStartCall={vi.fn()}
        onJoinCall={vi.fn()}
        onLeaveCall={vi.fn()}
        onLeaveRoom={vi.fn()}
        onToggleMute={vi.fn()}
        onToggleCamera={vi.fn()}
        onRenameRoom={onRenameRoom}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Room name"), {
      target: { value: "Design Review" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onRenameRoom).toHaveBeenCalledWith("Design Review"));
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
