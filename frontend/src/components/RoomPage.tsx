import type { ClientSignalingMessage } from "../types/signaling";
import type { RoomState } from "../state/roomReducer";
import { CallControls } from "./CallControls";
import { ConnectionStatus } from "./ConnectionStatus";
import { VideoPanel } from "./VideoPanel";

type RoomPageProps = {
  state: RoomState;
  onStartCall: () => Promise<void>;
  onJoinCall: () => Promise<void>;
  onLeaveCall: () => void;
  onLeaveRoom: () => Promise<void>;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  sendMessage: (message: ClientSignalingMessage) => void;
};

export function RoomPage({
  state,
  onStartCall,
  onJoinCall,
  onLeaveCall,
  onLeaveRoom,
  onToggleMute,
  onToggleCamera
}: RoomPageProps) {
  const shareUrl = `${location.origin}/room/${state.roomCode}`;
  const isCallHost = state.callHostParticipantId === state.participantId;
  const showJoinCall =
    state.callStatus === "CALL_PENDING" && state.callHostParticipantId !== state.participantId;
  const showStartCall = state.callStatus === "IDLE";
  const hasCamera = (state.localStream?.getVideoTracks().length ?? 0) > 0;
  const someoneReconnecting =
    state.reservedParticipantCount === 2 &&
    state.participants.some((participant) => participant.status === "DISCONNECTED");

  return (
    <main className="room-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">MiniRTC</p>
          <h1>Room {state.roomCode}</h1>
        </div>
        <ConnectionStatus status={state.connectionStatus} />
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <label>
            Share URL
            <input value={shareUrl} readOnly onFocus={(event) => event.currentTarget.select()} />
          </label>
          <div className="presence">
            <h2>Participants</h2>
            {state.participants.map((participant) => (
              <div key={participant.participant_id} className="participant-row">
                <span>{participant.username}</span>
                <small>{participant.status.toLowerCase()}</small>
              </div>
            ))}
          </div>
          {someoneReconnecting ? (
            <p className="notice">The other participant is reconnecting. This room slot is reserved temporarily.</p>
          ) : null}
          {state.mediaWarning ? <p className="notice">{state.mediaWarning}</p> : null}
          {state.error ? <p className="error">{state.error}</p> : null}
        </aside>

        <section className="call-surface">
          <div className="video-grid">
            <VideoPanel label="You" stream={state.localStream} muted />
            <VideoPanel label="Remote" stream={state.remoteStream} />
          </div>

          <div className="call-actions">
            {showStartCall ? (
              <button type="button" onClick={onStartCall}>
                Start Call
              </button>
            ) : null}
            {showJoinCall ? (
              <button type="button" onClick={onJoinCall}>
                Join Call
              </button>
            ) : null}
            {state.callStatus !== "IDLE" ? (
              <CallControls
                isMuted={state.isMuted}
                isCameraEnabled={state.isCameraEnabled}
                hasCamera={hasCamera}
                onToggleMute={onToggleMute}
                onToggleCamera={onToggleCamera}
                onLeaveCall={onLeaveCall}
                onLeaveRoom={onLeaveRoom}
              />
            ) : (
              <button type="button" className="secondary" onClick={onLeaveRoom}>
                Leave Room
              </button>
            )}
            {state.callStatus !== "IDLE" ? (
              <p className="subtle">{isCallHost ? "You started this call." : "You joined this call."}</p>
            ) : null}
          </div>
        </section>
      </section>
    </main>
  );
}

