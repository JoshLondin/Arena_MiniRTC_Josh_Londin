from __future__ import annotations

from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import (
    AppError,
    CallAlreadyStartedError,
    InvalidParticipantError,
    RoomNotFoundError,
)
from app.services.room_service import RoomService, RoomStatePayload
from app.websocket.connection_manager import ConnectionManager
from app.websocket.schemas import (
    AnswerPayload,
    EndCallPayload,
    HeartbeatPayload,
    IceCandidatePayload,
    JoinCallPayload,
    MediaConnectedPayload,
    OfferPayload,
    StartCallPayload,
    WebSocketMessage,
)


class SignalingService:
    def __init__(
        self,
        *,
        room_service: RoomService | None = None,
        connection_manager: ConnectionManager | None = None,
    ) -> None:
        self.room_service = room_service or RoomService()
        self.connection_manager = connection_manager or ConnectionManager()

    async def authenticate(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        participant_id: UUID,
        participant_token: str,
    ) -> None:
        await self.room_service.reconnect_participant(
            session,
            room_code=room_code,
            participant_id=participant_id,
            participant_token=participant_token,
        )

    async def send_initial_state(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        participant_id: UUID,
    ) -> None:
        state = await self.room_service.get_room_state_payload(session, room_code=room_code)
        await self.connection_manager.send_to_participant(
            room_code=room_code,
            participant_id=participant_id,
            message=self._event("room-state", self._room_state_payload(state)),
        )

    async def broadcast_current_room_state(self, session: AsyncSession, *, room_code: str) -> None:
        state = await self.room_service.get_room_state_payload(session, room_code=room_code)
        await self.broadcast_room_state(room_code=room_code, state=state)

    async def handle_raw_message(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        participant_id: UUID,
        raw_message: dict[str, Any],
    ) -> None:
        try:
            message = WebSocketMessage.model_validate(raw_message)
            await self._dispatch(
                session,
                room_code=room_code,
                participant_id=participant_id,
                message=message,
            )
        except CallAlreadyStartedError as exc:
            await self._send_error(room_code=room_code, participant_id=participant_id, error=exc)
        except (AppError, ValidationError, ValueError):
            await self._send_error(
                room_code=room_code,
                participant_id=participant_id,
                error=InvalidParticipantError(),
            )

    async def _dispatch(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        participant_id: UUID,
        message: WebSocketMessage,
    ) -> None:
        if message.type == "heartbeat":
            payload = HeartbeatPayload.model_validate(message.payload)
            self._validate_payload_participant(payload.participant_id, participant_id)
            await self.room_service.record_heartbeat(session, participant_id=participant_id)
            await session.commit()
            return

        if message.type == "start-call":
            payload = StartCallPayload.model_validate(message.payload)
            self._validate_payload_participant(payload.participant_id, participant_id)
            result = await self.room_service.start_call(
                session,
                room_code=room_code,
                participant_id=participant_id,
            )
            await self.connection_manager.broadcast_room(
                room_code=room_code,
                message=self._event(
                    "call-started",
                    {
                        "call_host_participant_id": str(participant_id),
                        "message": "A call has started. Join the call when ready.",
                    },
                ),
            )
            await self._broadcast_room_state(room_code=room_code, state=result.room_state)
            return

        if message.type == "join-call":
            payload = JoinCallPayload.model_validate(message.payload)
            self._validate_payload_participant(payload.participant_id, participant_id)
            result = await self.room_service.join_call(
                session,
                room_code=room_code,
                participant_id=participant_id,
            )
            if result.changed:
                await self.connection_manager.broadcast_room(
                    room_code=room_code,
                    message=self._event(
                        "call-joined",
                        {
                            "call_host_participant_id": str(
                                result.room_state.call_host_participant_id
                            ),
                            "room_status": "NEGOTIATING",
                        },
                    ),
                )
                await self._broadcast_room_state(room_code=room_code, state=result.room_state)
            return

        if message.type == "end-call":
            payload = EndCallPayload.model_validate(message.payload)
            self._validate_payload_participant(payload.participant_id, participant_id)
            result = await self.room_service.end_call(
                session,
                room_code=room_code,
                participant_id=participant_id,
            )
            if result.changed:
                await self.connection_manager.broadcast_room(
                    room_code=room_code,
                    message=self._event("call-ended", {"reason": result.reason}),
                )
                await self._broadcast_room_state(room_code=room_code, state=result.room_state)
            return

        if message.type == "media-connected":
            payload = MediaConnectedPayload.model_validate(message.payload)
            self._validate_payload_participant(payload.participant_id, participant_id)
            result = await self.room_service.mark_media_connected(
                session,
                room_code=room_code,
                participant_id=participant_id,
            )
            if result.changed:
                await self._broadcast_room_state(room_code=room_code, state=result.room_state)
            return

        if message.type == "offer":
            payload = OfferPayload.model_validate(message.payload)
            await self._forward_signaling(
                session,
                room_code=room_code,
                participant_id=participant_id,
                event_type="offer",
                payload={"sdp": payload.sdp},
            )
            return

        if message.type == "answer":
            payload = AnswerPayload.model_validate(message.payload)
            await self._forward_signaling(
                session,
                room_code=room_code,
                participant_id=participant_id,
                event_type="answer",
                payload={"sdp": payload.sdp},
            )
            return

        if message.type == "ice-candidate":
            payload = IceCandidatePayload.model_validate(message.payload)
            await self._forward_signaling(
                session,
                room_code=room_code,
                participant_id=participant_id,
                event_type="ice-candidate",
                payload=payload.model_dump(exclude_none=True),
            )
            return

        raise InvalidParticipantError()

    async def _forward_signaling(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        participant_id: UUID,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        await self.room_service.validate_signaling_sender(
            session,
            room_code=room_code,
            participant_id=participant_id,
        )
        delivered = await self.connection_manager.send_to_other_participants(
            room_code=room_code,
            sender_participant_id=participant_id,
            message=self._event(event_type, payload),
        )
        if not delivered:
            await self.connection_manager.send_to_participant(
                room_code=room_code,
                participant_id=participant_id,
                message=self._event(
                    "error",
                    {
                        "code": "PEER_NOT_CONNECTED",
                        "message": "The other participant is not connected.",
                    },
                ),
            )

    async def _broadcast_room_state(self, *, room_code: str, state: RoomStatePayload) -> None:
        await self.connection_manager.broadcast_room(
            room_code=room_code,
            message=self._event("room-state", self._room_state_payload(state)),
        )

    async def broadcast_room_state(
        self,
        *,
        room_code: str,
        state: RoomStatePayload | None,
    ) -> None:
        if state is None:
            return
        await self._broadcast_room_state(room_code=room_code, state=state)

    async def handle_disconnect(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        participant_id: UUID,
    ) -> None:
        try:
            result = await self.room_service.mark_participant_disconnected(
                session,
                room_code=room_code,
                participant_id=participant_id,
            )
        except (InvalidParticipantError, RoomNotFoundError):
            return
        if not result.changed:
            return
        await self.connection_manager.broadcast_room(
            room_code=room_code,
            message=self._event(
                "participant-disconnected",
                {
                    "participant_id": str(participant_id),
                    "reconnect_timeout_seconds": result.reconnect_timeout_seconds,
                },
            ),
        )
        await self.broadcast_room_state(room_code=room_code, state=result.room_state)

    async def _send_error(self, *, room_code: str, participant_id: UUID, error: AppError) -> None:
        await self.connection_manager.send_to_participant(
            room_code=room_code,
            participant_id=participant_id,
            message=self._event("error", {"code": error.code, "message": error.message}),
        )

    def _validate_payload_participant(
        self,
        payload_participant_id: UUID | None,
        authenticated_participant_id: UUID,
    ) -> None:
        if (
            payload_participant_id is not None
            and payload_participant_id != authenticated_participant_id
        ):
            raise InvalidParticipantError()

    def _room_state_payload(self, state: RoomStatePayload) -> dict[str, Any]:
        return {
            "room_status": state.room_status,
            "reserved_participant_count": state.reserved_participant_count,
            "capacity": state.capacity,
            "participants": [
                {
                    "participant_id": str(participant.participant_id),
                    "username": participant.username,
                    "status": participant.status,
                }
                for participant in state.participants
            ],
            "call_status": state.call_status,
            "call_host_participant_id": (
                str(state.call_host_participant_id) if state.call_host_participant_id else None
            ),
        }

    def _event(self, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        return {"type": event_type, "payload": payload}
