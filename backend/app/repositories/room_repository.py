from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Participant, ParticipantStatus, Room


class RoomRepository:
    async def create_room(
        self,
        session: AsyncSession,
        *,
        room_code: str,
        host_token_hash: str,
    ) -> Room:
        room = Room(room_code=room_code, host_token_hash=host_token_hash, status="EMPTY")
        session.add(room)
        await session.flush()
        return room

    async def get_room_by_code(
        self,
        session: AsyncSession,
        *,
        room_code: str,
    ) -> Room | None:
        result = await session.execute(select(Room).where(Room.room_code == room_code))
        return result.scalar_one_or_none()

    async def get_room_by_code_for_update(
        self,
        session: AsyncSession,
        *,
        room_code: str,
    ) -> Room | None:
        result = await session.execute(
            select(Room).where(Room.room_code == room_code).with_for_update()
        )
        return result.scalar_one_or_none()

    async def create_participant(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
        username: str,
        participant_token_hash: str,
    ) -> Participant:
        participant = Participant(
            room_id=room_id,
            username=username,
            participant_token_hash=participant_token_hash,
            status=ParticipantStatus.ACTIVE.value,
        )
        session.add(participant)
        await session.flush()
        return participant

    async def get_participant(
        self,
        session: AsyncSession,
        *,
        participant_id: UUID,
    ) -> Participant | None:
        result = await session.execute(select(Participant).where(Participant.id == participant_id))
        return result.scalar_one_or_none()

    async def get_participant_for_update(
        self,
        session: AsyncSession,
        *,
        participant_id: UUID,
    ) -> Participant | None:
        result = await session.execute(
            select(Participant).where(Participant.id == participant_id).with_for_update()
        )
        return result.scalar_one_or_none()

    async def list_room_participants(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
    ) -> list[Participant]:
        result = await session.execute(
            select(Participant)
            .where(Participant.room_id == room_id)
            .order_by(Participant.joined_at)
        )
        return list(result.scalars().all())

    async def list_reserved_slot_participants(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
        now: datetime,
    ) -> list[Participant]:
        result = await session.execute(
            select(Participant).where(
                Participant.room_id == room_id,
                or_(
                    Participant.status == ParticipantStatus.ACTIVE.value,
                    (
                        (Participant.status == ParticipantStatus.DISCONNECTED.value)
                        & (Participant.reconnect_deadline_at > now)
                    ),
                ),
            )
        )
        return list(result.scalars().all())

    async def count_reserved_slots(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
        now: datetime,
    ) -> int:
        return len(await self.list_reserved_slot_participants(session, room_id=room_id, now=now))

    async def update_room_status(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
        status: str,
        call_status: str | None = None,
    ) -> None:
        values: dict[str, str] = {"status": status}
        if call_status is not None:
            values["call_status"] = call_status
        await session.execute(update(Room).where(Room.id == room_id).values(**values))

    async def update_participant_last_seen(
        self,
        session: AsyncSession,
        *,
        participant_id: UUID,
        last_seen_at: datetime,
    ) -> None:
        await session.execute(
            update(Participant)
            .where(Participant.id == participant_id)
            .values(last_seen_at=last_seen_at)
        )

    async def record_media_connected(
        self,
        session: AsyncSession,
        *,
        participant_id: UUID,
        connected_at: datetime,
    ) -> None:
        await session.execute(
            update(Participant)
            .where(Participant.id == participant_id)
            .values(media_connected_at=connected_at)
        )

    async def clear_media_connected_for_room(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
    ) -> None:
        await session.execute(
            update(Participant)
            .where(Participant.room_id == room_id)
            .values(media_connected_at=None)
        )

    async def set_room_host_participant(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
        host_participant_id: UUID,
    ) -> None:
        await session.execute(
            update(Room)
            .where(Room.id == room_id)
            .values(host_participant_id=host_participant_id)
        )

    async def set_call_host(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
        call_host_participant_id: UUID | None,
    ) -> None:
        await session.execute(
            update(Room)
            .where(Room.id == room_id)
            .values(call_host_participant_id=call_host_participant_id)
        )

    async def remove_expired_disconnected_participants_for_room(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
        now: datetime,
    ) -> None:
        await session.execute(
            delete(Participant).where(
                Participant.room_id == room_id,
                Participant.status == ParticipantStatus.DISCONNECTED.value,
                Participant.reconnect_deadline_at <= now,
            )
        )

    async def remove_participant(
        self,
        session: AsyncSession,
        *,
        participant_id: UUID,
    ) -> None:
        await session.execute(delete(Participant).where(Participant.id == participant_id))

    async def delete_room(
        self,
        session: AsyncSession,
        *,
        room_id: UUID,
    ) -> None:
        await session.execute(delete(Room).where(Room.id == room_id))
