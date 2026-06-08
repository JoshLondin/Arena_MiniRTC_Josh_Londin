import type { RoomCredentials } from "../types/signaling";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
export const WS_BASE_URL = import.meta.env.VITE_WS_BASE_URL ?? "ws://localhost:8000";

type ParticipantResponse = {
  participant_id: string;
  username: string;
  is_room_host: boolean;
};

type CreateRoomResponse = {
  room_code: string;
  room_name: string;
  participant: ParticipantResponse;
  participant_token: string;
  host_token: string;
};

type JoinRoomResponse = {
  room_code: string;
  room_name: string;
  participant: ParticipantResponse;
  participant_token: string;
  room_status: string;
  reserved_participant_count: number;
};

export type AvailableRoom = {
  roomCode: string;
  roomName: string;
  hostUsername: string;
  reservedParticipantCount: number;
  capacity: 2;
  roomStatus: string;
  createdAt: string;
};

type AvailableRoomResponse = {
  room_code: string;
  room_name: string;
  host_username: string;
  reserved_participant_count: number;
  capacity: 2;
  room_status: string;
  created_at: string;
};

type AvailableRoomsResponse = {
  rooms: AvailableRoomResponse[];
};

type RenameRoomResponse = {
  room_name: string;
};

export type ReconnectResponse = {
  participant_id: string;
  room_code: string;
  room_status: string;
  call_status: string;
  reserved_participant_count: number;
  must_restart_peer_connection: boolean;
};

export type IceServersResponse = {
  ice_servers: RTCIceServer[];
};

type ErrorResponse = {
  error?: {
    code: string;
    message: string;
  };
};

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const data = (await response.json().catch(() => ({}))) as T & ErrorResponse;
  if (!response.ok) {
    throw new Error(data.error?.message ?? "Request failed.");
  }
  return data;
}

export async function createRoom(username: string, roomName?: string): Promise<RoomCredentials> {
  const cleanRoomName = roomName?.trim();
  const response = await requestJson<CreateRoomResponse>("/rooms", {
    method: "POST",
    body: JSON.stringify({ username, room_name: cleanRoomName || undefined })
  });
  return {
    roomCode: response.room_code,
    roomName: response.room_name,
    participantId: response.participant.participant_id,
    participantToken: response.participant_token,
    hostToken: response.host_token,
    username: response.participant.username
  };
}

export async function joinRoom(roomCode: string, username: string): Promise<RoomCredentials> {
  const response = await requestJson<JoinRoomResponse>(`/rooms/${roomCode}/join`, {
    method: "POST",
    body: JSON.stringify({ username })
  });
  return {
    roomCode: response.room_code,
    roomName: response.room_name,
    participantId: response.participant.participant_id,
    participantToken: response.participant_token,
    username: response.participant.username
  };
}

export async function fetchAvailableRooms(): Promise<AvailableRoom[]> {
  const response = await requestJson<AvailableRoomsResponse>("/rooms/available");
  return response.rooms.map((room) => ({
    roomCode: room.room_code,
    roomName: room.room_name,
    hostUsername: room.host_username,
    reservedParticipantCount: room.reserved_participant_count,
    capacity: room.capacity,
    roomStatus: room.room_status,
    createdAt: room.created_at
  }));
}

export async function reconnectRoom(credentials: RoomCredentials): Promise<ReconnectResponse> {
  return requestJson<ReconnectResponse>(`/rooms/${credentials.roomCode}/reconnect`, {
    method: "POST",
    body: JSON.stringify({
      participant_id: credentials.participantId,
      participant_token: credentials.participantToken
    })
  });
}

export async function leaveRoom(credentials: RoomCredentials): Promise<{ left: boolean; room_deleted: boolean }> {
  return requestJson(`/rooms/${credentials.roomCode}/leave`, {
    method: "POST",
    body: JSON.stringify({
      participant_id: credentials.participantId,
      participant_token: credentials.participantToken
    })
  });
}

export async function renameRoom(
  credentials: RoomCredentials,
  roomName: string
): Promise<string> {
  if (!credentials.hostToken) {
    throw new Error("Only the room host can rename this room.");
  }
  const response = await requestJson<RenameRoomResponse>(`/rooms/${credentials.roomCode}/name`, {
    method: "PATCH",
    body: JSON.stringify({
      participant_id: credentials.participantId,
      host_token: credentials.hostToken,
      room_name: roomName
    })
  });
  return response.room_name;
}

export async function fetchIceServers(credentials: RoomCredentials): Promise<RTCIceServer[]> {
  const response = await requestJson<IceServersResponse>(`/rooms/${credentials.roomCode}/ice-servers`, {
    method: "POST",
    body: JSON.stringify({
      participant_id: credentials.participantId,
      participant_token: credentials.participantToken
    })
  });
  return response.ice_servers;
}
