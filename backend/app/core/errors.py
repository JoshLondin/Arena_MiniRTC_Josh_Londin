from __future__ import annotations

from dataclasses import dataclass

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette import status


@dataclass(slots=True)
class AppError(Exception):
    code: str
    message: str
    http_status: int = status.HTTP_400_BAD_REQUEST


class RoomNotFoundError(AppError):
    def __init__(self) -> None:
        super().__init__("ROOM_NOT_FOUND", "Room not found.", status.HTTP_404_NOT_FOUND)


class RoomFullError(AppError):
    def __init__(self) -> None:
        super().__init__(
            "ROOM_FULL",
            "This room already has two participants.",
            status.HTTP_409_CONFLICT,
        )


class InvalidParticipantError(AppError):
    def __init__(self) -> None:
        super().__init__(
            "INVALID_PARTICIPANT",
            "Invalid participant credentials.",
            status.HTTP_401_UNAUTHORIZED,
        )


class InvalidHostTokenError(AppError):
    def __init__(self) -> None:
        super().__init__("INVALID_HOST_TOKEN", "Invalid host token.", status.HTTP_403_FORBIDDEN)


class CallAlreadyStartedError(AppError):
    def __init__(self) -> None:
        super().__init__(
            "CALL_ALREADY_STARTED",
            "Call already started, please join the existing call.",
            status.HTTP_409_CONFLICT,
        )


def error_payload(error: AppError) -> dict[str, dict[str, str]]:
    return {"error": {"code": error.code, "message": error.message}}


async def app_error_handler(_: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(error_payload(exc), status_code=exc.http_status)


async def validation_error_handler(_: Request, exc: ValidationError) -> JSONResponse:
    return JSONResponse(
        {"error": {"code": "VALIDATION_ERROR", "message": str(exc)}},
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
    )


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(AppError, app_error_handler)

