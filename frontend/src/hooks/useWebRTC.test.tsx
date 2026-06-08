import { render } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MediaStatus } from "../state/roomReducer";
import type { ClientSignalingMessage } from "../types/signaling";
import { useWebRTC } from "./useWebRTC";

class FakeTrack {
  enabled = true;
  stopped = false;
  id: string;

  constructor(public kind: "audio" | "video") {
    this.id = `${kind}-${Math.random()}`;
  }

  stop() {
    this.stopped = true;
  }
}

class FakeMediaStream {
  private tracks: FakeTrack[];

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }

  getTracks() {
    return [...this.tracks];
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }

  addTrack(track: FakeTrack) {
    this.tracks.push(track);
  }

  removeTrack(track: FakeTrack) {
    this.tracks = this.tracks.filter((candidate) => candidate !== track);
  }
}

class FakeSender {
  constructor(public track: FakeTrack | null) {}

  async replaceTrack(track: FakeTrack | null) {
    this.track = track;
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  senders: FakeSender[] = [];
  remoteDescription: RTCSessionDescriptionInit | null = null;
  addedCandidates: RTCIceCandidateInit[] = [];
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTrack(track: FakeTrack) {
    const sender = new FakeSender(track);
    this.senders.push(sender);
    return sender;
  }

  getSenders() {
    return this.senders;
  }

  async createOffer() {
    return { type: "offer" as const, sdp: "offer-sdp" };
  }

  async createAnswer() {
    return { type: "answer" as const, sdp: "answer-sdp" };
  }

  async setLocalDescription() {}

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit) {
    this.addedCandidates.push(candidate);
  }

  close() {}
}

type WebRtcApi = ReturnType<typeof useWebRTC>;

function renderWebRtc(sendMessage = vi.fn()) {
  let api: WebRtcApi | null = null;
  const onLocalStream = vi.fn();

  function Harness() {
    api = useWebRTC({
      credentials: {
        roomCode: "ROOM12345678",
        roomName: "Interview Prep",
        participantId: "alice-id",
        participantToken: "alice-token",
        username: "Alice"
      },
      participants: [],
      sendMessage: sendMessage as (message: ClientSignalingMessage) => void,
      getIceServers: async () => [],
      onLocalStream,
      onRemoteStream: vi.fn(),
      onMediaStatus: vi.fn((_status: MediaStatus) => undefined),
      onWarning: vi.fn()
    });
    return null;
  }

  render(<Harness />);
  return { api: api as unknown as WebRtcApi, onLocalStream };
}

describe("useWebRTC", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakePeerConnection.instances = [];
  });

  it("lets the call host add tracks before creating an offer", async () => {
    vi.stubGlobal("MediaStream", FakeMediaStream);
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    const sendMessage = vi.fn();
    const { api } = renderWebRtc(sendMessage);
    const stream = new FakeMediaStream([new FakeTrack("audio"), new FakeTrack("video")]);

    await act(async () => {
      api.attachLocalStream(stream as unknown as MediaStream, null);
      await api.beginNegotiation("alice-id");
    });

    expect(FakePeerConnection.instances[0].senders).toHaveLength(2);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "offer",
      payload: { sdp: { type: "offer", sdp: "offer-sdp" } }
    });
  });

  it("queues ICE candidates until a remote description exists", async () => {
    vi.stubGlobal("MediaStream", FakeMediaStream);
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    const { api } = renderWebRtc();
    const candidate = { candidate: "candidate:1" };

    await act(async () => {
      await api.handleIceCandidate(candidate);
      await api.handleOffer({ type: "offer", sdp: "offer-sdp" });
    });

    expect(FakePeerConnection.instances[0].addedCandidates).toEqual([candidate]);
  });

  it("stops camera tracks when camera is disabled and reacquires video when enabled", async () => {
    vi.stubGlobal("MediaStream", FakeMediaStream);
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    const { api, onLocalStream } = renderWebRtc();
    const audioTrack = new FakeTrack("audio");
    const videoTrack = new FakeTrack("video");
    const stream = new FakeMediaStream([audioTrack, videoTrack]);

    await act(async () => {
      api.attachLocalStream(stream as unknown as MediaStream, null);
      await api.disableCamera();
    });

    expect(videoTrack.stopped).toBe(true);
    expect(stream.getVideoTracks()).toHaveLength(0);

    const nextVideoTrack = new FakeTrack("video");
    await act(async () => {
      await api.enableCamera(nextVideoTrack as unknown as MediaStreamTrack);
    });

    expect(stream.getVideoTracks()).toEqual([nextVideoTrack]);
    expect(onLocalStream).toHaveBeenLastCalledWith(expect.any(FakeMediaStream));
  });
});
