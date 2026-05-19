from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

RoomStatusLiteral = Literal[
    "EMPTY",
    "WAITING_FOR_PARTICIPANT",
    "READY_FOR_CALL",
    "CALL_PENDING",
    "NEGOTIATING",
    "IN_CALL",
]

CallStatusLiteral = Literal["IDLE", "CALL_PENDING", "NEGOTIATING", "IN_CALL"]
ParticipantStatusLiteral = Literal["ACTIVE", "DISCONNECTED"]


class ErrorEnvelope(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorEnvelope


class UsernameRequestBase(BaseModel):
    username: str = Field(min_length=1)

    @field_validator("username", mode="before")
    @classmethod
    def validate_username(cls, value: str) -> str:
        trimmed = str(value).strip()
        if not trimmed:
            raise ValueError("Username is required.")
        if len(trimmed) > 40:
            raise ValueError("Username must be 40 characters or fewer.")
        return trimmed


class CreateRoomRequest(UsernameRequestBase):
    pass


class JoinRoomRequest(UsernameRequestBase):
    pass


class ParticipantDTO(BaseModel):
    participant_id: UUID
    username: str
    is_room_host: bool = False
    status: ParticipantStatusLiteral | None = None


class CreateRoomResponse(BaseModel):
    room_code: str
    participant: ParticipantDTO
    participant_token: str
    host_token: str


class JoinRoomResponse(BaseModel):
    room_code: str
    participant: ParticipantDTO
    participant_token: str
    room_status: RoomStatusLiteral
    reserved_participant_count: int


class DeleteRoomRequest(BaseModel):
    host_token: str


class DeleteRoomResponse(BaseModel):
    deleted: bool


class PublicRoomResponse(BaseModel):
    room_code: str
    status: RoomStatusLiteral
    reserved_participant_count: int
    capacity: Literal[2]
    call_status: CallStatusLiteral


class IceServer(BaseModel):
    urls: list[str]
    username: str | None = None
    credential: str | None = None


class IceServersRequest(BaseModel):
    participant_id: UUID
    participant_token: str


class IceServersResponse(BaseModel):
    ice_servers: list[IceServer]

