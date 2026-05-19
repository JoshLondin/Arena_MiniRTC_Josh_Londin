from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import (
    CreateRoomRequest,
    CreateRoomResponse,
    DeleteRoomRequest,
    DeleteRoomResponse,
    IceServersRequest,
    IceServersResponse,
    JoinRoomRequest,
    JoinRoomResponse,
    LeaveRoomRequest,
    LeaveRoomResponse,
    PublicRoomResponse,
    ReconnectRequest,
    ReconnectResponse,
)
from app.db.session import get_session
from app.services.runtime import ice_service, room_service, signaling_service

router = APIRouter(prefix="/rooms", tags=["rooms"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]


@router.post("", response_model=CreateRoomResponse)
async def create_room(
    request: CreateRoomRequest,
    session: SessionDep,
) -> CreateRoomResponse:
    result = await room_service.create_room(session, username=request.username)
    return CreateRoomResponse.model_validate(result, from_attributes=True)


@router.post("/{room_code}/join", response_model=JoinRoomResponse)
async def join_room(
    room_code: str,
    request: JoinRoomRequest,
    session: SessionDep,
) -> JoinRoomResponse:
    result = await room_service.join_room(session, room_code=room_code, username=request.username)
    state = await room_service.get_room_state_payload(session, room_code=room_code)
    await signaling_service.connection_manager.broadcast_room(
        room_code=room_code,
        message={
            "type": "participant-joined",
            "payload": {
                "participant_id": str(result.participant.participant_id),
                "username": result.participant.username,
                "reserved_participant_count": result.reserved_participant_count,
            },
        },
    )
    await signaling_service.broadcast_room_state(room_code=room_code, state=state)
    return JoinRoomResponse.model_validate(result, from_attributes=True)


@router.get("/{room_code}", response_model=PublicRoomResponse)
async def get_room(
    room_code: str,
    session: SessionDep,
) -> PublicRoomResponse:
    result = await room_service.get_public_room_state(session, room_code=room_code)
    return PublicRoomResponse.model_validate(result, from_attributes=True)


@router.post("/{room_code}/delete", response_model=DeleteRoomResponse)
async def delete_room(
    room_code: str,
    request: DeleteRoomRequest,
    session: SessionDep,
) -> DeleteRoomResponse:
    result = await room_service.delete_room_by_host(
        session,
        room_code=room_code,
        host_token=request.host_token,
    )
    return DeleteRoomResponse.model_validate(result, from_attributes=True)


@router.post("/{room_code}/leave", response_model=LeaveRoomResponse)
async def leave_room(
    room_code: str,
    request: LeaveRoomRequest,
    session: SessionDep,
) -> LeaveRoomResponse:
    result = await room_service.leave_room(
        session,
        room_code=room_code,
        participant_id=request.participant_id,
        participant_token=request.participant_token,
    )
    if result.call_ended:
        await signaling_service.connection_manager.broadcast_room(
            room_code=room_code,
            message={"type": "call-ended", "payload": {"reason": "PARTICIPANT_LEFT_ROOM"}},
        )
    if result.room_deleted:
        await signaling_service.connection_manager.broadcast_room(
            room_code=room_code,
            message={"type": "room-deleted", "payload": {"reason": "EMPTY_ROOM"}},
        )
    else:
        await signaling_service.connection_manager.broadcast_room(
            room_code=room_code,
            message={
                "type": "participant-left",
                "payload": {
                    "participant_id": str(result.participant_id),
                    "reserved_participant_count": result.reserved_participant_count,
                    "call_ended": result.call_ended,
                },
            },
        )
        await signaling_service.broadcast_room_state(room_code=room_code, state=result.room_state)
    return LeaveRoomResponse(left=result.left, room_deleted=result.room_deleted)


@router.post("/{room_code}/reconnect", response_model=ReconnectResponse)
async def reconnect_room(
    room_code: str,
    request: ReconnectRequest,
    session: SessionDep,
) -> ReconnectResponse:
    result = await room_service.reconnect_participant(
        session,
        room_code=room_code,
        participant_id=request.participant_id,
        participant_token=request.participant_token,
    )
    return ReconnectResponse.model_validate(result, from_attributes=True)


@router.post("/{room_code}/ice-servers", response_model=IceServersResponse)
async def get_ice_servers(
    room_code: str,
    request: IceServersRequest,
    session: SessionDep,
) -> IceServersResponse:
    participant = await room_service.validate_participant_credentials(
        session,
        participant_id=request.participant_id,
        participant_token=request.participant_token,
    )
    room = await room_service.repository.get_room_by_code(session, room_code=room_code)
    if room is None or participant.room_id != room.id:
        from app.core.errors import InvalidParticipantError

        raise InvalidParticipantError()
    return IceServersResponse(ice_servers=ice_service.get_ice_servers())
