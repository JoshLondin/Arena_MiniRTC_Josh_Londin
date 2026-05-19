from __future__ import annotations

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.errors import (
    CallAlreadyStartedError,
    InvalidHostTokenError,
    RoomFullError,
    RoomNotFoundError,
)
from app.db.base import Base
from app.db.models import CallStatus, DisconnectContext, Participant, ParticipantStatus, RoomStatus
from app.services.room_service import RoomService


@pytest.fixture
async def session_factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield factory
    finally:
        await engine.dispose()


@pytest.fixture
def room_service() -> RoomService:
    return RoomService()


async def test_create_room_creates_host_participant(session_factory, room_service):
    async with session_factory() as session:
        result = await room_service.create_room(session, username="  Alice  ")
        state = await room_service.get_public_room_state(session, room_code=result.room_code)
        participants = await room_service.list_room_participants(
            session,
            room_id=(
                await room_service.repository.get_room_by_code(session, room_code=result.room_code)
            ).id,
        )

    assert result.participant.username == "Alice"
    assert result.participant.is_room_host is True
    assert result.participant_token
    assert result.host_token
    assert state.status == RoomStatus.WAITING_FOR_PARTICIPANT.value
    assert state.call_status == CallStatus.IDLE.value
    assert state.reserved_participant_count == 1
    assert len(participants) == 1


async def test_join_room_succeeds_for_second_participant(session_factory, room_service):
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        joined = await room_service.join_room(
            session,
            room_code=created.room_code,
            username="Bob",
        )
        state = await room_service.get_public_room_state(session, room_code=created.room_code)

    assert joined.participant.username == "Bob"
    assert joined.participant.is_room_host is False
    assert joined.room_status == RoomStatus.READY_FOR_CALL.value
    assert joined.reserved_participant_count == 2
    assert state.status == RoomStatus.READY_FOR_CALL.value


async def test_join_room_rejects_third_participant(session_factory, room_service):
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        await room_service.join_room(session, room_code=created.room_code, username="Bob")
        with pytest.raises(RoomFullError):
            await room_service.join_room(session, room_code=created.room_code, username="Carol")


async def test_host_delete_deletes_room(session_factory, room_service):
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        result = await room_service.delete_room_by_host(
            session,
            room_code=created.room_code,
            host_token=created.host_token,
        )
        with pytest.raises(RoomNotFoundError):
            await room_service.get_public_room_state(session, room_code=created.room_code)

    assert result.deleted is True


async def test_host_delete_rejects_invalid_token(session_factory, room_service):
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        with pytest.raises(InvalidHostTokenError):
            await room_service.delete_room_by_host(
                session,
                room_code=created.room_code,
                host_token="wrong",
            )


async def test_start_call_first_sender_wins(session_factory, room_service):
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        joined = await room_service.join_room(session, room_code=created.room_code, username="Bob")
        result = await room_service.start_call(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
        )
        with pytest.raises(CallAlreadyStartedError):
            await room_service.start_call(
                session,
                room_code=created.room_code,
                participant_id=joined.participant.participant_id,
            )

    assert result.changed is True
    assert result.room_state.room_status == RoomStatus.CALL_PENDING.value
    assert result.room_state.call_status == CallStatus.CALL_PENDING.value
    assert result.room_state.call_host_participant_id == created.participant.participant_id


async def test_join_call_moves_pending_call_to_negotiating(session_factory, room_service):
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        joined = await room_service.join_room(session, room_code=created.room_code, username="Bob")
        await room_service.start_call(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
        )
        result = await room_service.join_call(
            session,
            room_code=created.room_code,
            participant_id=joined.participant.participant_id,
        )

    assert result.changed is True
    assert result.room_state.room_status == RoomStatus.NEGOTIATING.value
    assert result.room_state.call_status == CallStatus.NEGOTIATING.value


async def test_media_connected_requires_both_participants(session_factory, room_service):
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        joined = await room_service.join_room(session, room_code=created.room_code, username="Bob")
        await room_service.start_call(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
        )
        await room_service.join_call(
            session,
            room_code=created.room_code,
            participant_id=joined.participant.participant_id,
        )
        first = await room_service.mark_media_connected(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
        )
        second = await room_service.mark_media_connected(
            session,
            room_code=created.room_code,
            participant_id=joined.participant.participant_id,
        )

    assert first.changed is False
    assert first.room_state.call_status == CallStatus.NEGOTIATING.value
    assert second.changed is True
    assert second.room_state.call_status == CallStatus.IN_CALL.value


async def test_end_call_from_participant_keeps_room_ready(session_factory, room_service):
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        joined = await room_service.join_room(session, room_code=created.room_code, username="Bob")
        await room_service.start_call(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
        )
        await room_service.join_call(
            session,
            room_code=created.room_code,
            participant_id=joined.participant.participant_id,
        )
        result = await room_service.end_call(
            session,
            room_code=created.room_code,
            participant_id=joined.participant.participant_id,
        )

    assert result.changed is True
    assert result.reason == "PARTICIPANT_LEFT_CALL"
    assert result.room_state.call_status == CallStatus.IDLE.value
    assert result.room_state.room_status == RoomStatus.READY_FOR_CALL.value


async def test_active_call_disconnect_uses_45_second_timeout(session_factory, room_service):
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        await room_service.join_room(session, room_code=created.room_code, username="Bob")
        await room_service.start_call(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
        )
        result = await room_service.mark_participant_disconnected(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
        )
        participant = await room_service.repository.get_participant(
            session,
            participant_id=created.participant.participant_id,
        )

    assert result.changed is True
    assert result.reconnect_timeout_seconds == 45
    assert participant.status == ParticipantStatus.DISCONNECTED.value
    assert participant.disconnect_context == DisconnectContext.ACTIVE_CALL.value


async def test_room_only_disconnect_during_pending_call_uses_300_seconds(
    session_factory,
    room_service,
):
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        joined = await room_service.join_room(session, room_code=created.room_code, username="Bob")
        await room_service.start_call(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
        )
        result = await room_service.mark_participant_disconnected(
            session,
            room_code=created.room_code,
            participant_id=joined.participant.participant_id,
        )
        participant = await room_service.repository.get_participant(
            session,
            participant_id=joined.participant.participant_id,
        )

    assert result.reconnect_timeout_seconds == 300
    assert participant.disconnect_context == DisconnectContext.ROOM_ONLY.value


async def test_reconnecting_room_only_participant_during_pending_call_does_not_restart(
    session_factory,
    room_service,
):
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        joined = await room_service.join_room(session, room_code=created.room_code, username="Bob")
        await room_service.start_call(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
        )
        await room_service.mark_participant_disconnected(
            session,
            room_code=created.room_code,
            participant_id=joined.participant.participant_id,
        )
        result = await room_service.reconnect_participant(
            session,
            room_code=created.room_code,
            participant_id=joined.participant.participant_id,
            participant_token=joined.participant_token,
        )

    assert result.must_restart_peer_connection is False
    assert result.call_status == CallStatus.CALL_PENDING.value
    assert result.room_status == RoomStatus.CALL_PENDING.value


async def test_expired_active_call_participant_removal_ends_call(session_factory, room_service):
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        await room_service.join_room(session, room_code=created.room_code, username="Bob")
        await room_service.start_call(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
        )
        await room_service.mark_participant_disconnected(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
        )
        await session.execute(
            update(Participant)
            .where(Participant.id == created.participant.participant_id)
            .values(reconnect_deadline_at=room_service._now())
        )
        await session.commit()
        result = await room_service.remove_expired_participant(
            session,
            participant_id=created.participant.participant_id,
        )

    assert result is not None
    assert result.call_ended is True
    assert result.room_deleted is False
    assert result.room_state.call_status == CallStatus.IDLE.value
    assert result.room_state.room_status == RoomStatus.WAITING_FOR_PARTICIPANT.value
