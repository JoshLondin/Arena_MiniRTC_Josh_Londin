from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.errors import InvalidParticipantError, RoomNotFoundError
from app.db.session import AsyncSessionLocal
from app.services.signaling_service import SignalingService
from app.websocket.schemas import (
    WS_CLOSE_INTERNAL_ERROR,
    WS_CLOSE_INVALID_PARTICIPANT,
    WS_CLOSE_ROOM_NOT_FOUND,
)

router = APIRouter(tags=["signaling"])
signaling_service = SignalingService()


@router.websocket("/ws/rooms/{room_code}")
async def room_websocket(
    websocket: WebSocket,
    room_code: str,
    participant_id: str,
    participant_token: str,
) -> None:
    try:
        parsed_participant_id = UUID(participant_id)
    except ValueError:
        await websocket.close(code=WS_CLOSE_INVALID_PARTICIPANT)
        return

    async with AsyncSessionLocal() as session:
        try:
            await signaling_service.authenticate(
                session,
                room_code=room_code,
                participant_id=parsed_participant_id,
                participant_token=participant_token,
            )
        except RoomNotFoundError:
            await websocket.close(code=WS_CLOSE_ROOM_NOT_FOUND)
            return
        except InvalidParticipantError:
            await websocket.close(code=WS_CLOSE_INVALID_PARTICIPANT)
            return

    await signaling_service.connection_manager.connect(
        room_code=room_code,
        participant_id=parsed_participant_id,
        websocket=websocket,
    )

    async with AsyncSessionLocal() as session:
        await signaling_service.send_initial_state(
            session,
            room_code=room_code,
            participant_id=parsed_participant_id,
        )

    try:
        while True:
            raw_message = await websocket.receive_json()
            async with AsyncSessionLocal() as session:
                await signaling_service.handle_raw_message(
                    session,
                    room_code=room_code,
                    participant_id=parsed_participant_id,
                    raw_message=raw_message,
                )
    except WebSocketDisconnect:
        signaling_service.connection_manager.disconnect(
            room_code=room_code,
            participant_id=parsed_participant_id,
            websocket=websocket,
        )
    except Exception:
        signaling_service.connection_manager.disconnect(
            room_code=room_code,
            participant_id=parsed_participant_id,
            websocket=websocket,
        )
        await websocket.close(code=WS_CLOSE_INTERNAL_ERROR)

