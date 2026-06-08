import { useEffect, useRef, useState } from "react";

import type { RoomState } from "../state/roomReducer";
import {
  selectCanJoinCall,
  selectCanStartCall,
  selectCurrentParticipant,
  selectRemoteParticipant
} from "../state/roomSelectors";
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
  const [hasCopiedShareUrl, setHasCopiedShareUrl] = useState(false);
  const shareUrlInputRef = useRef<HTMLInputElement | null>(null);
  const shareUrl = `${location.origin}/room/${state.roomCode}`;
  const currentParticipant = selectCurrentParticipant(state);
  const remoteParticipant = selectRemoteParticipant(state);
  const isCallHost = state.callHostParticipantId === state.participantId;
  const hasLocalMedia = state.localStream !== null;
  const isCallStarted = state.callStatus !== "IDLE";
  const showJoinCall = selectCanJoinCall(state);
  const showStartCall = selectCanStartCall(state);
  const hasCamera = (state.localStream?.getVideoTracks().length ?? 0) > 0;
  const remoteMediaState = remoteParticipant
    ? state.participantMediaStates[remoteParticipant.participant_id]
    : undefined;
  const localLabel = currentParticipant?.username ?? state.username;
  const isRemoteInCall =
    remoteParticipant !== null &&
    isCallStarted &&
    (remoteParticipant.participant_id === state.callHostParticipantId || remoteMediaState !== undefined);
  const localCenterLabel = !isCallStarted || !hasLocalMedia ? localLabel : undefined;
  const remoteCenterLabel =
    remoteParticipant && (!isCallStarted || !isRemoteInCall || !hasLocalMedia)
      ? !isCallStarted
        ? remoteParticipant.username
        : isRemoteInCall
          ? `${remoteParticipant.username} is in the call`
          : `${remoteParticipant.username} has not joined the call`
      : undefined;
  const someoneReconnecting =
    state.reservedParticipantCount === 2 &&
    state.participants.some((participant) => participant.status === "DISCONNECTED");

  useEffect(() => {
    if (!hasCopiedShareUrl) {
      return;
    }
    const timeout = window.setTimeout(() => setHasCopiedShareUrl(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [hasCopiedShareUrl]);

  const copyShareUrl = async () => {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(shareUrl);
      setHasCopiedShareUrl(true);
      return;
    }
    shareUrlInputRef.current?.select();
    document.execCommand("copy");
    setHasCopiedShareUrl(true);
  };

  return (
    <main className="room-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">MiniRTC</p>
          <h1>{state.roomName}</h1>
        </div>
        <ConnectionStatus label="Room" status={state.connectionStatus} />
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <label>
            Share URL
            <span className="share-url-row">
              <input
                ref={shareUrlInputRef}
                value={shareUrl}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
              <button type="button" className="secondary" onClick={copyShareUrl}>
                {hasCopiedShareUrl ? "Copied" : "Copy Room Link"}
              </button>
            </span>
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
          <div className={remoteParticipant ? "video-grid" : "video-grid video-grid-single"}>
            <VideoPanel
              label={localLabel}
              stream={state.localStream}
              isCameraEnabled={state.isCameraEnabled}
              isMuted={state.isMuted}
              muted
              showAudioIndicator={hasLocalMedia}
              centerLabel={localCenterLabel}
            />
            {remoteParticipant ? (
              <VideoPanel
                label={remoteParticipant.username}
                stream={state.remoteStream}
                isCameraEnabled={remoteMediaState?.isCameraEnabled ?? true}
                isMuted={remoteMediaState?.isMuted ?? false}
                showAudioIndicator={hasLocalMedia && remoteMediaState !== undefined}
                centerLabel={remoteCenterLabel}
              />
            ) : null}
          </div>

          <div className={remoteParticipant ? "call-actions" : "call-actions call-actions-single"}>
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
            {hasLocalMedia && state.callStatus !== "IDLE" ? (
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
            {hasLocalMedia && state.callStatus !== "IDLE" ? (
              <div className="call-status-row">
                <span className="subtle">{isCallHost ? "You started this call." : "You joined this call."}</span>
                <ConnectionStatus label="Call" status={state.mediaStatus} />
              </div>
            ) : null}
          </div>
        </section>
      </section>
    </main>
  );
}
