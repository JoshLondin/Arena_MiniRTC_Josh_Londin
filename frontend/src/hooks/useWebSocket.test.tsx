import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerSignalingMessage } from "../types/signaling";
import { useWebSocket } from "./useWebSocket";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readyState = FakeWebSocket.OPEN;
  sentMessages: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sentMessages.push(message);
  }

  close() {
    this.readyState = 3;
  }
}

function SocketHarness({
  onMessage,
  onClose = vi.fn(),
  onFatalClose = vi.fn()
}: {
  onMessage: (message: ServerSignalingMessage) => void;
  onClose?: () => void;
  onFatalClose?: () => void;
}) {
  useWebSocket({
    roomCode: "ROOM12345678",
    participantId: "alice-id",
    participantToken: "alice-token",
    enabled: true,
    onMessage,
    onClose,
    onFatalClose
  });
  return null;
}

describe("useWebSocket", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
  });

  it("does not recreate the socket when callback props change", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const firstMessageHandler = vi.fn();
    const secondMessageHandler = vi.fn();
    const { rerender } = render(<SocketHarness onMessage={firstMessageHandler} />);

    rerender(<SocketHarness onMessage={secondMessageHandler} />);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("calls reconnect close handler for unexpected close codes", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onClose = vi.fn();
    render(<SocketHarness onMessage={vi.fn()} onClose={onClose} />);

    FakeWebSocket.instances[0].onclose?.({ code: 1006 } as CloseEvent);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls fatal close handler for invalid auth and room close codes", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onClose = vi.fn();
    const onFatalClose = vi.fn();
    render(
      <SocketHarness onMessage={vi.fn()} onClose={onClose} onFatalClose={onFatalClose} />
    );

    FakeWebSocket.instances[0].onclose?.({ code: 4401 } as CloseEvent);

    expect(onFatalClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
