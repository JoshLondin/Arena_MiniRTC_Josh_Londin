from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import (
    InvalidHostTokenError,
    InvalidParticipantError,
    RoomFullError,
    RoomNotFoundError,
)
from app.core.security import generate_opaque_token, generate_room_code, hash_token, verify_token
from app.db.models import CallStatus, Participant, ParticipantStatus, RoomStatus
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
class DeleteRoomResult:
    deleted: bool


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

    def _clean_username(self, username: str) -> str:
        clean = username.strip()
        if not clean:
            raise ValueError("Username is required.")
        if len(clean) > 40:
            raise ValueError("Username must be 40 characters or fewer.")
        return clean

    def _now(self) -> datetime:
        return datetime.now(UTC)
