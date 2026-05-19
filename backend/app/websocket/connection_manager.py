from __future__ import annotations

from contextlib import suppress
from uuid import UUID

from fastapi import WebSocket

from app.websocket.schemas import WS_CLOSE_DUPLICATE_CONNECTION


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: dict[str, dict[str, WebSocket]] = {}

    async def connect(self, *, room_code: str, participant_id: UUID, websocket: WebSocket) -> None:
        await websocket.accept()
        room_connections = self.active_connections.setdefault(room_code, {})
        participant_key = str(participant_id)
        old_socket = room_connections.get(participant_key)
        room_connections[participant_key] = websocket
        if old_socket is not None and old_socket is not websocket:
            with suppress(RuntimeError):
                await old_socket.close(code=WS_CLOSE_DUPLICATE_CONNECTION)

    def disconnect(self, *, room_code: str, participant_id: UUID, websocket: WebSocket) -> bool:
        participant_key = str(participant_id)
        room_connections = self.active_connections.get(room_code)
        if not room_connections or room_connections.get(participant_key) is not websocket:
            return False
        del room_connections[participant_key]
        if not room_connections:
            del self.active_connections[room_code]
        return True

    def get(self, *, room_code: str, participant_id: UUID) -> WebSocket | None:
        return self.active_connections.get(room_code, {}).get(str(participant_id))

    async def send_to_participant(
        self,
        *,
        room_code: str,
        participant_id: UUID,
        message: dict,
    ) -> bool:
        websocket = self.get(room_code=room_code, participant_id=participant_id)
        if websocket is None:
            return False
        await websocket.send_json(message)
        return True

    async def broadcast_room(self, *, room_code: str, message: dict) -> None:
        sockets = list(self.active_connections.get(room_code, {}).values())
        for websocket in sockets:
            await websocket.send_json(message)

    async def send_to_other_participants(
        self,
        *,
        room_code: str,
        sender_participant_id: UUID,
        message: dict,
    ) -> bool:
        delivered = False
        room_connections = self.active_connections.get(room_code, {})
        for participant_id, websocket in list(room_connections.items()):
            if participant_id == str(sender_participant_id):
                continue
            await websocket.send_json(message)
            delivered = True
        return delivered
