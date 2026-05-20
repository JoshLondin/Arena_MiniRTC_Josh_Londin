from __future__ import annotations

from functools import cached_property

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def normalize_database_url(database_url: str) -> str:
    if database_url.startswith("postgresql+asyncpg://"):
        return database_url
    if database_url.startswith("postgresql://"):
        return database_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if database_url.startswith("postgres://"):
        return database_url.replace("postgres://", "postgresql+asyncpg://", 1)
    return database_url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/minirtc"
    stun_server_url: str = "stun:stun.l.google.com:19302"
    turn_server_url: str = ""
    turn_username: str = ""
    turn_password: str = ""
    cors_allowed_origins: str = "http://localhost:5173"
    room_code_length: int = 12
    token_hash_secret: str = Field(default="change-me-for-local-development", min_length=16)

    active_call_reconnect_timeout_seconds: int = 45
    room_offline_timeout_seconds: int = 300
    heartbeat_interval_seconds: int = 10
    heartbeat_stale_after_seconds: int = 30
    cleanup_interval_seconds: int = 10

    @field_validator("database_url")
    @classmethod
    def validate_database_url(cls, value: str) -> str:
        return normalize_database_url(value)

    @cached_property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_allowed_origins.split(",") if origin.strip()]


settings = Settings()
