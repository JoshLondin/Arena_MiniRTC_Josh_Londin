from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import UTC, datetime, timedelta

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.services.runtime import room_service, signaling_service


async def cleanup_stale_heartbeats_once() -> None:
    stale_before = datetime.now(UTC) - timedelta(seconds=settings.heartbeat_stale_after_seconds)
    async with AsyncSessionLocal() as session:
        stale_participants = await room_service.repository.list_stale_active_participants(
            session,
            stale_before=stale_before,
        )

    for participant in stale_participants:
        async with AsyncSessionLocal() as session:
            room = await room_service.repository.get_room_by_id(
                session,
                room_id=participant.room_id,
            )
            if room is None:
                continue
            await signaling_service.handle_disconnect(
                session,
                room_code=room.room_code,
                participant_id=participant.id,
            )


async def cleanup_expired_reconnects_once() -> None:
    now = datetime.now(UTC)
    async with AsyncSessionLocal() as session:
        expired_participants = await room_service.repository.list_expired_disconnected_participants(
            session,
            now=now,
        )

    for participant in expired_participants:
        async with AsyncSessionLocal() as session:
            room = await room_service.repository.get_room_by_id(
                session,
                room_id=participant.room_id,
            )
            if room is None:
                continue
            result = await room_service.remove_expired_participant(
                session,
                participant_id=participant.id,
            )
            if result is None:
                continue
            if result.call_ended:
                await signaling_service.connection_manager.broadcast_room(
                    room_code=room.room_code,
                    message={"type": "call-ended", "payload": {"reason": "RECONNECT_TIMEOUT"}},
                )
            if result.room_deleted:
                await signaling_service.connection_manager.broadcast_room(
                    room_code=room.room_code,
                    message={"type": "room-deleted", "payload": {"reason": "EMPTY_ROOM"}},
                )
            else:
                await signaling_service.broadcast_room_state(
                    room_code=room.room_code,
                    state=result.room_state,
                )


async def cleanup_loop() -> None:
    while True:
        await cleanup_stale_heartbeats_once()
        await cleanup_expired_reconnects_once()
        await asyncio.sleep(settings.cleanup_interval_seconds)


def start_cleanup_tasks() -> list[asyncio.Task]:
    return [asyncio.create_task(cleanup_loop())]


async def stop_cleanup_tasks(tasks: list[asyncio.Task]) -> None:
    for task in tasks:
        task.cancel()
    for task in tasks:
        with suppress(asyncio.CancelledError):
            await task

