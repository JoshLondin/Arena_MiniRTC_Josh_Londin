import { useCallback } from "react";

import {
  createRoom,
  fetchAvailableRooms,
  fetchIceServers,
  joinRoom,
  leaveRoom,
  reconnectRoom,
  renameRoom,
  type AvailableRoom,
  type ReconnectResponse
} from "../api/rooms";
import type { RoomCredentials } from "../types/signaling";

const STORAGE_KEY = "minirtc-room";
const USERNAME_STORAGE_KEY = "minirtc-username";

export function saveUsername(username: string): void {
  sessionStorage.setItem(USERNAME_STORAGE_KEY, username);
}

export function loadUsername(): string {
  return sessionStorage.getItem(USERNAME_STORAGE_KEY) ?? "";
}

export function saveCredentials(credentials: RoomCredentials): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
  saveUsername(credentials.username);
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
    return {
      ...credentials,
      roomName: credentials.roomName ?? credentials.roomCode
    };
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function useRoom() {
  const create = useCallback(async (username: string, roomName?: string) => {
    const credentials = await createRoom(username, roomName);
    saveCredentials(credentials);
    history.pushState(null, "", `/room/${credentials.roomCode}`);
    return credentials;
  }, []);

  const join = useCallback(async (roomCode: string, username: string) => {
    const credentials = await joinRoom(roomCode, username);
    saveCredentials(credentials);
    return credentials;
  }, []);

  const availableRooms = useCallback(async (): Promise<AvailableRoom[]> => {
    return fetchAvailableRooms();
  }, []);

  const reconnect = useCallback(async (credentials: RoomCredentials): Promise<ReconnectResponse> => {
    return reconnectRoom(credentials);
  }, []);

  const leave = useCallback(async (credentials: RoomCredentials) => {
    const result = await leaveRoom(credentials);
    clearCredentials();
    return result;
  }, []);

  const rename = useCallback(async (credentials: RoomCredentials, roomName: string) => {
    return renameRoom(credentials, roomName);
  }, []);

  const iceServers = useCallback(async (credentials: RoomCredentials) => {
    return fetchIceServers(credentials);
  }, []);

  return { create, join, reconnect, leave, rename, iceServers, availableRooms };
}
