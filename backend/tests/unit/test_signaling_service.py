from __future__ import annotations

from uuid import UUID

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.base import Base
from app.services.room_service import RoomService
from app.services.signaling_service import SignalingService


class FakeConnectionManager:
    def __init__(self) -> None:
        self.sent: list[tuple[str, UUID, dict]] = []
        self.broadcasts: list[tuple[str, dict]] = []
        self.forwarded: list[tuple[str, UUID, dict]] = []
        self.deliver_to_peer = True

    async def send_to_participant(
        self,
        *,
        room_code: str,
        participant_id: UUID,
        message: dict,
    ) -> bool:
        self.sent.append((room_code, participant_id, message))
        return True

    async def broadcast_room(self, *, room_code: str, message: dict) -> None:
        self.broadcasts.append((room_code, message))

    async def send_to_other_participants(
        self,
        *,
        room_code: str,
        sender_participant_id: UUID,
        message: dict,
    ) -> bool:
        self.forwarded.append((room_code, sender_participant_id, message))
        return self.deliver_to_peer


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


async def test_signaling_start_call_broadcasts_and_second_start_gets_error(session_factory):
    room_service = RoomService()
    connection_manager = FakeConnectionManager()
    signaling_service = SignalingService(
        room_service=room_service,
        connection_manager=connection_manager,
    )
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        joined = await room_service.join_room(session, room_code=created.room_code, username="Bob")
        await signaling_service.handle_raw_message(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
            raw_message={"type": "start-call", "payload": {}},
        )
        await signaling_service.handle_raw_message(
            session,
            room_code=created.room_code,
            participant_id=joined.participant.participant_id,
            raw_message={"type": "start-call", "payload": {}},
        )

    assert [message["type"] for _, message in connection_manager.broadcasts] == [
        "call-started",
        "room-state",
    ]
    assert connection_manager.sent[-1][2]["type"] == "error"
    assert connection_manager.sent[-1][2]["payload"]["code"] == "CALL_ALREADY_STARTED"


async def test_signaling_forwards_offer_to_other_participant(session_factory):
    room_service = RoomService()
    connection_manager = FakeConnectionManager()
    signaling_service = SignalingService(
        room_service=room_service,
        connection_manager=connection_manager,
    )
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        await room_service.join_room(session, room_code=created.room_code, username="Bob")
        await signaling_service.handle_raw_message(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
            raw_message={"type": "offer", "payload": {"sdp": {"type": "offer", "sdp": "v=0"}}},
        )

    assert connection_manager.forwarded == [
        (
            created.room_code,
            created.participant.participant_id,
            {"type": "offer", "payload": {"sdp": {"type": "offer", "sdp": "v=0"}}},
        )
    ]


async def test_signaling_broadcasts_media_state_to_other_participant(session_factory):
    room_service = RoomService()
    connection_manager = FakeConnectionManager()
    signaling_service = SignalingService(
        room_service=room_service,
        connection_manager=connection_manager,
    )
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        await room_service.join_room(session, room_code=created.room_code, username="Bob")
        await signaling_service.handle_raw_message(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
            raw_message={
                "type": "media-state",
                "payload": {
                    "participant_id": str(created.participant.participant_id),
                    "is_muted": True,
                    "is_camera_enabled": False,
                },
            },
        )

    assert connection_manager.forwarded == [
        (
            created.room_code,
            created.participant.participant_id,
            {
                "type": "participant-media-state",
                "payload": {
                    "participant_id": str(created.participant.participant_id),
                    "is_muted": True,
                    "is_camera_enabled": False,
                },
            },
        )
    ]


async def test_signaling_rejects_mismatched_payload_participant(session_factory):
    room_service = RoomService()
    connection_manager = FakeConnectionManager()
    signaling_service = SignalingService(
        room_service=room_service,
        connection_manager=connection_manager,
    )
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        joined = await room_service.join_room(session, room_code=created.room_code, username="Bob")
        await signaling_service.handle_raw_message(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
            raw_message={
                "type": "heartbeat",
                "payload": {"participant_id": str(joined.participant.participant_id)},
            },
        )

    assert connection_manager.sent[-1][2]["type"] == "error"
    assert connection_manager.sent[-1][2]["payload"]["code"] == "INVALID_PARTICIPANT"


async def test_signaling_rejects_spoofed_media_state_participant(session_factory):
    room_service = RoomService()
    connection_manager = FakeConnectionManager()
    signaling_service = SignalingService(
        room_service=room_service,
        connection_manager=connection_manager,
    )
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        joined = await room_service.join_room(session, room_code=created.room_code, username="Bob")
        await signaling_service.handle_raw_message(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
            raw_message={
                "type": "media-state",
                "payload": {
                    "participant_id": str(joined.participant.participant_id),
                    "is_muted": False,
                    "is_camera_enabled": True,
                },
            },
        )

    assert connection_manager.forwarded == []
    assert connection_manager.sent[-1][2]["type"] == "error"
    assert connection_manager.sent[-1][2]["payload"]["code"] == "INVALID_PARTICIPANT"


async def test_disconnect_after_room_deletion_is_idempotent(session_factory):
    room_service = RoomService()
    connection_manager = FakeConnectionManager()
    signaling_service = SignalingService(
        room_service=room_service,
        connection_manager=connection_manager,
    )
    async with session_factory() as session:
        created = await room_service.create_room(session, username="Alice")
        await room_service.leave_room(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
            participant_token=created.participant_token,
        )
        await signaling_service.handle_disconnect(
            session,
            room_code=created.room_code,
            participant_id=created.participant.participant_id,
        )

    assert connection_manager.broadcasts == []
