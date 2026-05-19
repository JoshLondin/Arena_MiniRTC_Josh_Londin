import { useCallback } from "react";

import {
  createRoom,
  fetchIceServers,
  joinRoom,
  leaveRoom,
  reconnectRoom,
  type ReconnectResponse
} from "../api/rooms";
import type { RoomCredentials } from "../types/signaling";

const STORAGE_KEY = "minirtc-room";

export function saveCredentials(credentials: RoomCredentials): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
}

export function loadCredentials(roomCode?: string): RoomCredentials | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const credentials = JSON.parse(raw) as RoomCredentials;
    if (roomCode && credentials.roomCode !== roomCode) {
      return null;
    }
    return credentials;
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function useRoom() {
  const create = useCallback(async (username: string) => {
    const credentials = await createRoom(username);
    saveCredentials(credentials);
    history.pushState(null, "", `/room/${credentials.roomCode}`);
    return credentials;
  }, []);

  const join = useCallback(async (roomCode: string, username: string) => {
    const credentials = await joinRoom(roomCode, username);
    saveCredentials(credentials);
    return credentials;
  }, []);

  const reconnect = useCallback(async (credentials: RoomCredentials): Promise<ReconnectResponse> => {
    return reconnectRoom(credentials);
  }, []);

  const leave = useCallback(async (credentials: RoomCredentials) => {
    const result = await leaveRoom(credentials);
    clearCredentials();
    return result;
  }, []);

  const iceServers = useCallback(async (credentials: RoomCredentials) => {
    return fetchIceServers(credentials);
  }, []);

  return { create, join, reconnect, leave, iceServers };
}

