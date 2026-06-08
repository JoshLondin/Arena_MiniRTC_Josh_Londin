import { useCallback, useEffect, useState } from "react";

import type { AvailableRoom } from "../api/rooms";

type LobbyPageProps = {
  username: string;
  loadAvailableRooms: () => Promise<AvailableRoom[]>;
  onCreateRoom: (roomName?: string) => Promise<void>;
  onJoinRoom: (roomCode: string) => Promise<void>;
};

const POLL_INTERVAL_MS = 5000;

export function LobbyPage({
  username,
  loadAvailableRooms,
  onCreateRoom,
  onJoinRoom
}: LobbyPageProps) {
  const [rooms, setRooms] = useState<AvailableRoom[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [joiningRoomCode, setJoiningRoomCode] = useState<string | null>(null);
  const [roomName, setRoomName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refreshRooms = useCallback(async (options: { preserveError?: boolean } = {}) => {
    if (!options.preserveError) {
      setError(null);
    }
    try {
      const nextRooms = await loadAvailableRooms();
      setRooms(nextRooms);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load rooms.");
    } finally {
      setIsLoading(false);
    }
  }, [loadAvailableRooms]);

  useEffect(() => {
    void refreshRooms();
    const interval = window.setInterval(() => void refreshRooms(), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refreshRooms]);

  async function handleCreateRoom() {
    setError(null);
    setIsCreating(true);
    try {
      await onCreateRoom(roomName);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unable to create a room.");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleJoinRoom(roomCode: string) {
    setError(null);
    setJoiningRoomCode(roomCode);
    try {
      await onJoinRoom(roomCode);
    } catch (joinError) {
      setError(
        joinError instanceof Error
          ? `${joinError.message} The room list has been refreshed.`
          : "Unable to join that room. The room list has been refreshed."
      );
      await refreshRooms({ preserveError: true });
    } finally {
      setJoiningRoomCode(null);
    }
  }

  return (
    <main className="lobby-shell">
      <header className="lobby-header">
        <div>
          <p className="eyebrow">MiniRTC</p>
          <h1>Available Rooms</h1>
          <p className="subtle">Signed in as {username}</p>
        </div>
        <form
          className="lobby-actions"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreateRoom();
          }}
        >
          <label className="lobby-room-name">
            Room name
            <input
              value={roomName}
              maxLength={60}
              onChange={(event) => setRoomName(event.target.value)}
              placeholder="Optional"
            />
          </label>
          <button
            type="button"
            className="secondary"
            onClick={() => void refreshRooms()}
            disabled={isLoading}
          >
            Refresh
          </button>
          <button type="submit" disabled={isCreating}>
            {isCreating ? "Creating..." : "Create New Room"}
          </button>
        </form>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <section className="room-list" aria-label="Available rooms">
        {isLoading ? <p className="subtle">Loading rooms...</p> : null}
        {!isLoading && rooms.length === 0 ? (
          <div className="empty-state">
            <h2>No rooms available</h2>
            <p className="subtle">Create a room and wait for someone to join.</p>
          </div>
        ) : null}
        {rooms.map((room) => (
          <article key={room.roomCode} className="room-card">
            <div>
              <h2>{room.roomName}</h2>
              <p className="subtle">Hosted by {room.hostUsername}</p>
            </div>
            <div className="room-card-meta">
              <span>
                {room.reservedParticipantCount} / {room.capacity} participants
              </span>
              <button
                type="button"
                onClick={() => void handleJoinRoom(room.roomCode)}
                disabled={joiningRoomCode === room.roomCode}
              >
                {joiningRoomCode === room.roomCode ? "Joining..." : "Join Room"}
              </button>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
