from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.errors import InvalidHostTokenError, RoomFullError, RoomNotFoundError
from app.db.base import Base
from app.db.models import CallStatus, RoomStatus
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

