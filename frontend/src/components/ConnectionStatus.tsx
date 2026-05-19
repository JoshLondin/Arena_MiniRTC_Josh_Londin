import type { ConnectionStatus as ConnectionStatusValue } from "../state/roomReducer";

type ConnectionStatusProps = {
  status: ConnectionStatusValue;
};

export function ConnectionStatus({ status }: ConnectionStatusProps) {
  return (
    <span className={`status status-${status}`}>
      <span aria-hidden="true" />
      {status}
    </span>
  );
}

