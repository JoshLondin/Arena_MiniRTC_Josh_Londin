import type { ConnectionStatus as ConnectionStatusValue, MediaStatus } from "../state/roomReducer";

type ConnectionStatusProps = {
  label?: string;
  status: ConnectionStatusValue | MediaStatus;
};

export function ConnectionStatus({ label, status }: ConnectionStatusProps) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {label ? `${label}: ` : null}
      {status}
    </span>
  );
}
