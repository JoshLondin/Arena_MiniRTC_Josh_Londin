from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import (
    CallAlreadyStartedError,
    InvalidHostTokenError,
    InvalidParticipantError,
    RoomFullError,
    RoomNotFoundError,
)
from app.core.security import generate_opaque_token, generate_room_code, hash_token, verify_token
from app.db.models import (
    CallStatus,
    DisconnectContext,
    Participant,
    ParticipantStatus,
    Room,
    RoomStatus,
)
from app.repositories.room_repository import RoomRepository


@dataclass(slots=True)
class ParticipantDTO:
    participant_id: UUID
    username: str
    is_room_host: bool = False
    status: str | None = None


@dataclass(slots=True)
class CreateRoomResult:
    room_code: str
    participant: ParticipantDTO
    participant_token: str
    host_token: str


@dataclass(slots=True)
class JoinRoomResult:
    room_code: str
    participant: ParticipantDTO
    participant_token: str
    room_status: str
    reserved_participant_count: int


@dataclass(slots=True)
class PublicRoomState:
    room_code: str
    status: str
    reserved_participant_count: int
    capacity: int
    call_status: str


@dataclass(slots=True)
class RoomStatePayload:
    room_status: str
    reserved_participant_count: int
    capacity: int
    participants: list[ParticipantDTO]
    call_status: str
    call_host_participant_id: UUID | None


@dataclass(slots=True)
class DeleteRoomResult:
    deleted: bool


@dataclass(slots=True)
class LeaveRoomResult:
    left: bool
    room_deleted: bool
    participant_id: UUID
    reserved_participant_count: int
    call_ended: bool
    room_state: RoomStatePayload | None = None


@dataclass(slots=True)
class ReconnectResult:
    participant_id: UUID
    room_code: str
    room_status: str
    call_status: str
    reserved_participant_count: int
    must_restart_peer_connection: bool
    was_disconnected: bool


@dataclass(slots=True)
class DisconnectResult:
    changed: bool
    participant_id: UUID
    reconnect_timeout_seconds: int
    room_state: RoomStatePayload | None = None


@dataclass(slots=True)
class CallTransitionResult:
    changed: bool
    room_state: RoomStatePayload
    reason: str | None = None


class RoomService:
    def __init__(self, repository: RoomRepository | None = None) -> None:
        self.repository = repository or RoomRepository()

    async def create_room(self, session: AsyncSession, *, username: str) -> CreateRoomResult:
        clean_username = self._clean_username(username)
        host_token = generate_opaque_token()
        participant_token = generate_opaque_token()

        for attempt in range(3):
            room_code = generate_room_code()
            try:
                async with session.begin():
                    room = await self.repository.create_room(
                        session,
                        room_code=room_code,
                        host_token_hash=hash_token(host_token),
                    )
                    participant = await self.repository.create_participant(
                        session,
                        room_id=room.id,
                        username=clean_username,
                        participant_token_hash=hash_token(participant_token),
                    )
                    await self.repository.set_room_host_participant(
                        session,
                        room_id=room.id,
                        host_participant_id=participant.id,
                    )
                    await self.repository.update_room_status(
                        session,
                        room_id=room.id,
                        status=RoomStatus.WAITING_FOR_PARTICIPANT.value,
                        call_status=CallStatus.IDLE.value,
                    )
                return CreateRoomResult(
                    room_code=room_code,
                    participant=ParticipantDTO(
                        participant_id=participant.id,
                        username=participant.username,
                        is_room_host=True,
                    ),
                    participant_token=participant_token,
                    host_token=host_token,
                )
            except IntegrityError:
                await session.rollback()
                if attempt == 2:
                    raise

        raise RuntimeError("Room code generation failed")

    async def join_room(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        username: str,
    ) -> JoinRoomResult:
        clean_username = self._clean_username(username)
        participant_token = generate_opaque_token()
        now = self._now()

        async with session.begin():
            room = await self.repository.get_room_by_code_for_update(session, room_code=room_code)
            if room is None:
                raise RoomNotFoundError()

            await self.repository.remove_expired_disconnected_participants_for_room(
                session,
                room_id=room.id,
                now=now,
            )
            reserved = await self.repository.list_reserved_slot_participants(
                session,
                room_id=room.id,
                now=now,
            )
            if not reserved:
                await self.repository.delete_room(session, room_id=room.id)
                raise RoomNotFoundError()
            if len(reserved) >= 2:
                raise RoomFullError()

            participant = await self.repository.create_participant(
                session,
                room_id=room.id,
                username=clean_username,
                participant_token_hash=hash_token(participant_token),
            )
            reserved_after = await self.repository.list_reserved_slot_participants(
                session,
                room_id=room.id,
                now=now,
            )
            room.status = self._status_for_idle_room(reserved_after)
            if room.call_status == CallStatus.CALL_PENDING.value:
                room.status = RoomStatus.CALL_PENDING.value

        return JoinRoomResult(
            room_code=room_code,
            participant=ParticipantDTO(
                participant_id=participant.id,
                username=participant.username,
                is_room_host=False,
            ),
            participant_token=participant_token,
            room_status=room.status,
            reserved_participant_count=len(reserved_after),
        )

    async def get_public_room_state(
        self, session: AsyncSession, *, room_code: str
    ) -> PublicRoomState:
        room = await self.repository.get_room_by_code(session, room_code=room_code)
        if room is None:
            raise RoomNotFoundError()
        count = await self.repository.count_reserved_slots(
            session, room_id=room.id, now=self._now()
        )
        return PublicRoomState(
            room_code=room.room_code,
            status=room.status,
            reserved_participant_count=count,
            capacity=2,
            call_status=room.call_status,
        )

    async def get_room_state_payload(
        self,
        session: AsyncSession,
        *,
        room_code: str,
    ) -> RoomStatePayload:
        room = await self.repository.get_room_by_code(session, room_code=room_code)
        if room is None:
            raise RoomNotFoundError()
        return await self._room_state_payload(session, room=room)

    async def start_call(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        participant_id: UUID,
    ) -> CallTransitionResult:
        async with session.begin():
            room = await self.repository.get_room_by_code_for_update(session, room_code=room_code)
            if room is None:
                raise RoomNotFoundError()
            participant = await self._active_room_participant_for_update(
                session,
                room=room,
                participant_id=participant_id,
            )
            if room.call_status != CallStatus.IDLE.value:
                raise CallAlreadyStartedError()

            room.call_status = CallStatus.CALL_PENDING.value
            room.status = RoomStatus.CALL_PENDING.value
            room.call_host_participant_id = participant.id
            await self.repository.clear_media_connected_for_room(session, room_id=room.id)
            payload = await self._room_state_payload(session, room=room)
        return CallTransitionResult(changed=True, room_state=payload)

    async def join_call(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        participant_id: UUID,
    ) -> CallTransitionResult:
        async with session.begin():
            room = await self.repository.get_room_by_code_for_update(session, room_code=room_code)
            if room is None:
                raise RoomNotFoundError()
            await self._active_room_participant_for_update(
                session,
                room=room,
                participant_id=participant_id,
            )
            if room.call_status != CallStatus.CALL_PENDING.value:
                payload = await self._room_state_payload(session, room=room)
                return CallTransitionResult(changed=False, room_state=payload)

            active = await self._active_participants(session, room_id=room.id)
            if len(active) < 2:
                payload = await self._room_state_payload(session, room=room)
                return CallTransitionResult(changed=False, room_state=payload)

            room.call_status = CallStatus.NEGOTIATING.value
            room.status = RoomStatus.NEGOTIATING.value
            await self.repository.clear_media_connected_for_room(session, room_id=room.id)
            payload = await self._room_state_payload(session, room=room)
        return CallTransitionResult(changed=True, room_state=payload)

    async def end_call(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        participant_id: UUID,
    ) -> CallTransitionResult:
        async with session.begin():
            room = await self.repository.get_room_by_code_for_update(session, room_code=room_code)
            if room is None:
                raise RoomNotFoundError()
            participant = await self._active_room_participant_for_update(
                session,
                room=room,
                participant_id=participant_id,
            )
            if room.call_status == CallStatus.IDLE.value:
                payload = await self._room_state_payload(session, room=room)
                return CallTransitionResult(changed=False, room_state=payload)
            if not self._is_active_call_participant(room=room, participant=participant):
                payload = await self._room_state_payload(session, room=room)
                return CallTransitionResult(changed=False, room_state=payload)

            reason = (
                "HOST_ENDED"
                if participant.id == room.call_host_participant_id
                else "PARTICIPANT_LEFT_CALL"
            )
            room.call_status = CallStatus.IDLE.value
            room.call_host_participant_id = None
            await self.repository.clear_media_connected_for_room(session, room_id=room.id)
            reserved = await self.repository.list_reserved_slot_participants(
                session,
                room_id=room.id,
                now=self._now(),
            )
            room.status = self._status_for_idle_room(reserved)
            payload = await self._room_state_payload(session, room=room)
        return CallTransitionResult(changed=True, room_state=payload, reason=reason)

    async def mark_media_connected(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        participant_id: UUID,
    ) -> CallTransitionResult:
        async with session.begin():
            room = await self.repository.get_room_by_code_for_update(session, room_code=room_code)
            if room is None:
                raise RoomNotFoundError()
            await self._active_room_participant_for_update(
                session,
                room=room,
                participant_id=participant_id,
            )
            if room.call_status not in {CallStatus.NEGOTIATING.value, CallStatus.IN_CALL.value}:
                payload = await self._room_state_payload(session, room=room)
                return CallTransitionResult(changed=False, room_state=payload)

            await self.repository.record_media_connected(
                session,
                participant_id=participant_id,
                connected_at=self._now(),
            )
            active = await self._active_participants(session, room_id=room.id)
            all_connected = bool(active) and all(p.media_connected_at for p in active)
            changed = False
            if all_connected and room.call_status != CallStatus.IN_CALL.value:
                room.call_status = CallStatus.IN_CALL.value
                room.status = RoomStatus.IN_CALL.value
                changed = True
            payload = await self._room_state_payload(session, room=room)
        return CallTransitionResult(changed=changed, room_state=payload)

    async def record_heartbeat(
        self,
        session: AsyncSession,
        *,
        participant_id: UUID,
    ) -> None:
        await self.repository.update_participant_last_seen(
            session,
            participant_id=participant_id,
            last_seen_at=self._now(),
        )

    async def validate_signaling_sender(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        participant_id: UUID,
    ) -> Participant:
        room = await self.repository.get_room_by_code(session, room_code=room_code)
        if room is None:
            raise RoomNotFoundError()
        participant = await self.repository.get_participant(session, participant_id=participant_id)
        if (
            participant is None
            or participant.room_id != room.id
            or participant.status != ParticipantStatus.ACTIVE.value
        ):
            raise InvalidParticipantError()
        return participant

    async def delete_room_by_host(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        host_token: str,
    ) -> DeleteRoomResult:
        async with session.begin():
            room = await self.repository.get_room_by_code_for_update(session, room_code=room_code)
            if room is None:
                raise RoomNotFoundError()
            if not verify_token(host_token, room.host_token_hash):
                raise InvalidHostTokenError()
            await self.repository.delete_room(session, room_id=room.id)
        return DeleteRoomResult(deleted=True)

    async def leave_room(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        participant_id: UUID,
        participant_token: str,
    ) -> LeaveRoomResult:
        async with session.begin():
            room = await self.repository.get_room_by_code_for_update(session, room_code=room_code)
            if room is None:
                raise RoomNotFoundError()
            participant = await self.repository.get_participant_for_update(
                session,
                participant_id=participant_id,
            )
            if (
                participant is None
                or participant.room_id != room.id
                or not verify_token(participant_token, participant.participant_token_hash)
            ):
                raise InvalidParticipantError()

            call_ended = room.call_status != CallStatus.IDLE.value
            if call_ended:
                room.call_status = CallStatus.IDLE.value
                room.call_host_participant_id = None
                await self.repository.clear_media_connected_for_room(session, room_id=room.id)

            await self.repository.remove_participant(session, participant_id=participant.id)
            remaining = await self.repository.list_room_participants(session, room_id=room.id)
            if not remaining:
                await self.repository.delete_room(session, room_id=room.id)
                return LeaveRoomResult(
                    left=True,
                    room_deleted=True,
                    participant_id=participant.id,
                    reserved_participant_count=0,
                    call_ended=call_ended,
                )

            reserved = await self.repository.list_reserved_slot_participants(
                session,
                room_id=room.id,
                now=self._now(),
            )
            if room.call_status == CallStatus.IDLE.value:
                room.status = self._status_for_idle_room(reserved)
            payload = await self._room_state_payload(session, room=room)
        return LeaveRoomResult(
            left=True,
            room_deleted=False,
            participant_id=participant_id,
            reserved_participant_count=payload.reserved_participant_count,
            call_ended=call_ended,
            room_state=payload,
        )

    async def reconnect_participant(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        participant_id: UUID,
        participant_token: str,
    ) -> ReconnectResult:
        now = self._now()
        async with session.begin():
            room = await self.repository.get_room_by_code_for_update(session, room_code=room_code)
            if room is None:
                raise RoomNotFoundError()
            participant = await self.repository.get_participant_for_update(
                session,
                participant_id=participant_id,
            )
            if (
                participant is None
                or participant.room_id != room.id
                or not verify_token(participant_token, participant.participant_token_hash)
            ):
                raise InvalidParticipantError()

            was_disconnected = participant.status == ParticipantStatus.DISCONNECTED.value
            previous_context = participant.disconnect_context
            if was_disconnected:
                if participant.reconnect_deadline_at is None or not self._is_future(
                    participant.reconnect_deadline_at,
                    now,
                ):
                    raise InvalidParticipantError()
                await self.repository.mark_participant_active(
                    session,
                    participant_id=participant.id,
                    last_seen_at=now,
                )
                participant.status = ParticipantStatus.ACTIVE.value
                participant.disconnect_context = None
                participant.reconnect_deadline_at = None
                participant.disconnected_at = None
            elif participant.status == ParticipantStatus.ACTIVE.value:
                await self.repository.update_participant_last_seen(
                    session,
                    participant_id=participant.id,
                    last_seen_at=now,
                )
            else:
                raise InvalidParticipantError()

            must_restart = await self._recompute_call_state_for_reconnect(
                session,
                room=room,
                participant=participant,
                previous_context=previous_context,
            )
            if must_restart and room.call_status in {
                CallStatus.NEGOTIATING.value,
                CallStatus.CALL_PENDING.value,
            }:
                await self.repository.clear_media_connected_for_room(session, room_id=room.id)
            if room.call_status == CallStatus.IDLE.value:
                reserved = await self.repository.list_reserved_slot_participants(
                    session,
                    room_id=room.id,
                    now=now,
                )
                room.status = self._status_for_idle_room(reserved)

            payload = await self._room_state_payload(session, room=room)
        return ReconnectResult(
            participant_id=participant_id,
            room_code=room_code,
            room_status=payload.room_status,
            call_status=payload.call_status,
            reserved_participant_count=payload.reserved_participant_count,
            must_restart_peer_connection=must_restart,
            was_disconnected=was_disconnected,
        )

    async def mark_participant_disconnected(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        participant_id: UUID,
    ) -> DisconnectResult:
        now = self._now()
        async with session.begin():
            room = await self.repository.get_room_by_code_for_update(session, room_code=room_code)
            if room is None:
                raise RoomNotFoundError()
            participant = await self.repository.get_participant_for_update(
                session,
                participant_id=participant_id,
            )
            if participant is None or participant.room_id != room.id:
                raise InvalidParticipantError()
            if participant.status == ParticipantStatus.DISCONNECTED.value:
                payload = await self._room_state_payload(session, room=room)
                return DisconnectResult(
                    changed=False,
                    participant_id=participant.id,
                    reconnect_timeout_seconds=0,
                    room_state=payload,
                )

            context = self._disconnect_context(room=room, participant=participant)
            timeout_seconds = (
                settings.active_call_reconnect_timeout_seconds
                if context == DisconnectContext.ACTIVE_CALL.value
                else settings.room_offline_timeout_seconds
            )
            await self.repository.mark_participant_disconnected(
                session,
                participant_id=participant.id,
                disconnected_at=now,
                reconnect_deadline_at=now + timedelta(seconds=timeout_seconds),
                disconnect_context=context,
            )
            participant.status = ParticipantStatus.DISCONNECTED.value
            participant.reconnect_deadline_at = now + timedelta(seconds=timeout_seconds)
            participant.disconnect_context = context
            payload = await self._room_state_payload(session, room=room)
        return DisconnectResult(
            changed=True,
            participant_id=participant_id,
            reconnect_timeout_seconds=timeout_seconds,
            room_state=payload,
        )

    async def remove_expired_participant(
        self,
        session: AsyncSession,
        *,
        participant_id: UUID,
    ) -> LeaveRoomResult | None:
        now = self._now()
        async with session.begin():
            participant = await self.repository.get_participant_for_update(
                session,
                participant_id=participant_id,
            )
            if (
                participant is None
                or participant.status != ParticipantStatus.DISCONNECTED.value
                or participant.reconnect_deadline_at is None
                or self._is_future(participant.reconnect_deadline_at, now)
            ):
                return None
            room = await self.repository.get_room_by_id_for_update(
                session,
                room_id=participant.room_id,
            )
            if room is None:
                return None

            call_ended = participant.disconnect_context == DisconnectContext.ACTIVE_CALL.value
            if call_ended:
                room.call_status = CallStatus.IDLE.value
                room.call_host_participant_id = None
                await self.repository.clear_media_connected_for_room(session, room_id=room.id)

            await self.repository.remove_participant(session, participant_id=participant.id)
            remaining = await self.repository.list_room_participants(session, room_id=room.id)
            if not remaining:
                await self.repository.delete_room(session, room_id=room.id)
                return LeaveRoomResult(
                    left=True,
                    room_deleted=True,
                    participant_id=participant.id,
                    reserved_participant_count=0,
                    call_ended=call_ended,
                )

            reserved = await self.repository.list_reserved_slot_participants(
                session,
                room_id=room.id,
                now=now,
            )
            if room.call_status == CallStatus.IDLE.value:
                room.status = self._status_for_idle_room(reserved)
            payload = await self._room_state_payload(session, room=room)
        return LeaveRoomResult(
            left=True,
            room_deleted=False,
            participant_id=participant_id,
            reserved_participant_count=payload.reserved_participant_count,
            call_ended=call_ended,
            room_state=payload,
        )

    async def validate_participant_credentials(
        self,
        session: AsyncSession,
        *,
        participant_id: UUID,
        participant_token: str,
    ) -> Participant:
        participant = await self.repository.get_participant(session, participant_id=participant_id)
        if participant is None or not verify_token(
            participant_token,
            participant.participant_token_hash,
        ):
            raise InvalidParticipantError()
        return participant

    async def validate_websocket_credentials(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        participant_id: UUID,
        participant_token: str,
    ) -> Participant:
        room = await self.repository.get_room_by_code(session, room_code=room_code)
        if room is None:
            raise RoomNotFoundError()
        participant = await self.validate_participant_credentials(
            session,
            participant_id=participant_id,
            participant_token=participant_token,
        )
        if participant.room_id != room.id or participant.status != ParticipantStatus.ACTIVE.value:
            raise InvalidParticipantError()
        return participant

    async def list_room_participants(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
    ) -> list[Participant]:
        return await self.repository.list_room_participants(session, room_id=room_id)

    def _status_for_idle_room(self, reserved_participants: list[Participant]) -> str:
        active_count = sum(
            1 for p in reserved_participants if p.status == ParticipantStatus.ACTIVE.value
        )
        if active_count == 2:
            return RoomStatus.READY_FOR_CALL.value
        if reserved_participants:
            return RoomStatus.WAITING_FOR_PARTICIPANT.value
        return RoomStatus.EMPTY.value

    async def _active_room_participant_for_update(
        self,
        session: AsyncSession,
        *,
        room: Room,
        participant_id: UUID,
    ) -> Participant:
        participant = await self.repository.get_participant_for_update(
            session,
            participant_id=participant_id,
        )
        if (
            participant is None
            or participant.room_id != room.id
            or participant.status != ParticipantStatus.ACTIVE.value
        ):
            raise InvalidParticipantError()
        return participant

    async def _active_participants(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
    ) -> list[Participant]:
        participants = await self.repository.list_room_participants(session, room_id=room_id)
        return [p for p in participants if p.status == ParticipantStatus.ACTIVE.value]

    def _is_active_call_participant(self, *, room: Room, participant: Participant) -> bool:
        if room.call_status == CallStatus.CALL_PENDING.value:
            return participant.id == room.call_host_participant_id
        if room.call_status in {CallStatus.NEGOTIATING.value, CallStatus.IN_CALL.value}:
            return participant.status == ParticipantStatus.ACTIVE.value
        return False

    def _disconnect_context(self, *, room: Room, participant: Participant) -> str:
        if self._is_active_call_participant(room=room, participant=participant):
            return DisconnectContext.ACTIVE_CALL.value
        return DisconnectContext.ROOM_ONLY.value

    async def _recompute_call_state_for_reconnect(
        self,
        session: AsyncSession,
        *,
        room: Room,
        participant: Participant,
        previous_context: str | None,
    ) -> bool:
        if room.call_status == CallStatus.IDLE.value:
            return False

        if room.call_status == CallStatus.CALL_PENDING.value:
            return (
                participant.id == room.call_host_participant_id
                or previous_context == DisconnectContext.ACTIVE_CALL.value
            )

        if room.call_status in {CallStatus.NEGOTIATING.value, CallStatus.IN_CALL.value}:
            active = await self._active_participants(session, room_id=room.id)
            if len(active) >= 2:
                room.call_status = CallStatus.NEGOTIATING.value
                room.status = RoomStatus.NEGOTIATING.value
            else:
                room.call_status = CallStatus.CALL_PENDING.value
                room.status = RoomStatus.CALL_PENDING.value
            return True

        return False

    def _is_future(self, value: datetime, now: datetime) -> bool:
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value > now

    async def _room_state_payload(self, session: AsyncSession, *, room: Room) -> RoomStatePayload:
        now = self._now()
        participants = await self.repository.list_room_participants(session, room_id=room.id)
        reserved = [
            participant
            for participant in participants
            if participant.status == ParticipantStatus.ACTIVE.value
            or (
                participant.status == ParticipantStatus.DISCONNECTED.value
                and participant.reconnect_deadline_at is not None
                and self._is_future(participant.reconnect_deadline_at, now)
            )
        ]
        return RoomStatePayload(
            room_status=room.status,
            reserved_participant_count=len(reserved),
            capacity=2,
            participants=[
                ParticipantDTO(
                    participant_id=participant.id,
                    username=participant.username,
                    is_room_host=participant.id == room.host_participant_id,
                    status=participant.status,
                )
                for participant in participants
            ],
            call_status=room.call_status,
            call_host_participant_id=room.call_host_participant_id,
        )

    def _clean_username(self, username: str) -> str:
        clean = username.strip()
        if not clean:
            raise ValueError("Username is required.")
        if len(clean) > 40:
            raise ValueError("Username must be 40 characters or fewer.")
        return clean

    def _now(self) -> datetime:
        return datetime.now(UTC)
