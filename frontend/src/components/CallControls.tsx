type CallControlsProps = {
  isMuted: boolean;
  isCameraEnabled: boolean;
  hasCamera: boolean;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onLeaveCall: () => void;
  onLeaveRoom: () => void;
};

export function CallControls({
  isMuted,
  isCameraEnabled,
  hasCamera,
  onToggleMute,
  onToggleCamera,
  onLeaveCall,
  onLeaveRoom
}: CallControlsProps) {
  return (
    <div className="controls">
      <button type="button" onClick={onToggleMute}>
        {isMuted ? "Unmute" : "Mute"}
      </button>
      <button type="button" onClick={onToggleCamera} disabled={isCameraEnabled && !hasCamera}>
        {isCameraEnabled ? "Camera Off" : "Camera On"}
      </button>
      <button type="button" onClick={onLeaveCall}>
        Leave Call
      </button>
      <button type="button" className="danger" onClick={onLeaveRoom}>
        Leave Room
      </button>
    </div>
  );
}
