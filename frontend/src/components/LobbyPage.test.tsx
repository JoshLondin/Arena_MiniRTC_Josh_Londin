import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AvailableRoom } from "../api/rooms";
import { LobbyPage } from "./LobbyPage";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeRoom(overrides: Partial<AvailableRoom> = {}): AvailableRoom {
  return {
    roomCode: "ROOM12345678",
    roomName: "Interview Prep",
    hostUsername: "Alice",
    reservedParticipantCount: 1,
    capacity: 2,
    roomStatus: "READY_FOR_CALL",
    createdAt: "2026-06-08T12:00:00Z",
    ...overrides
  };
}

function renderLobby(overrides: {
  loadAvailableRooms?: () => Promise<AvailableRoom[]>;
  onCreateRoom?: (roomName?: string) => Promise<void>;
  onJoinRoom?: (roomCode: string) => Promise<void>;
} = {}) {
  const props = {
    username: "Bob",
    loadAvailableRooms: overrides.loadAvailableRooms ?? vi.fn().mockResolvedValue([]),
    onCreateRoom: overrides.onCreateRoom ?? vi.fn().mockResolvedValue(undefined),
    onJoinRoom: overrides.onJoinRoom ?? vi.fn().mockResolvedValue(undefined)
  };

  return {
    ...render(<LobbyPage {...props} />),
    props
  };
}

describe("LobbyPage", () => {
  it("shows an empty state when no rooms are available", async () => {
    renderLobby();

    expect(await screen.findByText("No rooms available")).toBeTruthy();
    expect(screen.getByText("Signed in as Bob")).toBeTruthy();
  });

  it("renders available rooms and joins the selected room", async () => {
    const onJoinRoom = vi.fn().mockResolvedValue(undefined);
    renderLobby({
      loadAvailableRooms: vi.fn().mockResolvedValue([makeRoom()]),
      onJoinRoom
    });

    expect(await screen.findByText("Interview Prep")).toBeTruthy();
    expect(screen.getByText("Hosted by Alice")).toBeTruthy();
    expect(screen.queryByText("Room ROOM12345678")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Join Room" }));

    await waitFor(() => expect(onJoinRoom).toHaveBeenCalledWith("ROOM12345678"));
  });

  it("creates a new room from the lobby", async () => {
    const onCreateRoom = vi.fn().mockResolvedValue(undefined);
    renderLobby({ onCreateRoom });

    fireEvent.click(screen.getByRole("button", { name: "Create New Room" }));

    await waitFor(() => expect(onCreateRoom).toHaveBeenCalledWith(""));
  });

  it("sends an optional room name when creating a room", async () => {
    const onCreateRoom = vi.fn().mockResolvedValue(undefined);
    renderLobby({ onCreateRoom });

    fireEvent.change(screen.getByLabelText("Room name"), {
      target: { value: "Pairing Room" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create New Room" }));

    await waitFor(() => expect(onCreateRoom).toHaveBeenCalledWith("Pairing Room"));
  });

  it("polls available rooms every five seconds", async () => {
    vi.useFakeTimers();
    const loadAvailableRooms = vi.fn().mockResolvedValue([]);
    renderLobby({ loadAvailableRooms });

    expect(loadAvailableRooms).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(loadAvailableRooms).toHaveBeenCalledTimes(2);
  });

  it("refreshes the room list when joining a stale room fails", async () => {
    const loadAvailableRooms = vi
      .fn()
      .mockResolvedValueOnce([makeRoom()])
      .mockResolvedValueOnce([]);
    const onJoinRoom = vi.fn().mockRejectedValue(new Error("Room is full."));
    renderLobby({ loadAvailableRooms, onJoinRoom });

    expect(await screen.findByText("Interview Prep")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Join Room" }));

    expect(await screen.findByText("Room is full. The room list has been refreshed.")).toBeTruthy();
    await waitFor(() => expect(loadAvailableRooms).toHaveBeenCalledTimes(2));
    expect(screen.getByText("No rooms available")).toBeTruthy();
  });
});
