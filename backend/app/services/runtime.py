from __future__ import annotations

from app.services.ice_service import IceService
from app.services.room_service import RoomService
from app.services.signaling_service import SignalingService
from app.websocket.connection_manager import ConnectionManager

connection_manager = ConnectionManager()
room_service = RoomService()
ice_service = IceService()
signaling_service = SignalingService(
    room_service=room_service,
    connection_manager=connection_manager,
)

