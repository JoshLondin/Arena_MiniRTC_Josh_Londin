from __future__ import annotations

from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field

WS_CLOSE_INVALID_PARTICIPANT = 4401
WS_CLOSE_ROOM_NOT_FOUND = 4404
WS_CLOSE_ROOM_FULL = 4409
WS_CLOSE_ROOM_DELETED = 4410
WS_CLOSE_DUPLICATE_CONNECTION = 4429
WS_CLOSE_INTERNAL_ERROR = 4500


class WebSocketMessage(BaseModel):
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)


class HeartbeatPayload(BaseModel):
    participant_id: UUID | None = None


class StartCallPayload(BaseModel):
    participant_id: UUID | None = None


class JoinCallPayload(BaseModel):
    participant_id: UUID | None = None


class EndCallPayload(BaseModel):
    participant_id: UUID | None = None


class MediaConnectedPayload(BaseModel):
    participant_id: UUID | None = None


class OfferPayload(BaseModel):
    sdp: dict[str, Any]


class AnswerPayload(BaseModel):
    sdp: dict[str, Any]


class IceCandidatePayload(BaseModel):
    candidate: str | None = None
    sdpMid: str | None = None
    sdpMLineIndex: int | None = None
    usernameFragment: str | None = None

