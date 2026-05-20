from __future__ import annotations

from app.core.config import Settings, normalize_database_url


def test_normalize_database_url_accepts_render_postgres_scheme() -> None:
    assert (
        normalize_database_url("postgres://user:pass@host:5432/db")
        == "postgresql+asyncpg://user:pass@host:5432/db"
    )


def test_normalize_database_url_accepts_postgresql_scheme() -> None:
    assert (
        normalize_database_url("postgresql://user:pass@host:5432/db")
        == "postgresql+asyncpg://user:pass@host:5432/db"
    )


def test_normalize_database_url_preserves_asyncpg_scheme() -> None:
    assert (
        normalize_database_url("postgresql+asyncpg://user:pass@host:5432/db")
        == "postgresql+asyncpg://user:pass@host:5432/db"
    )


def test_settings_parse_comma_separated_cors_origins() -> None:
    settings = Settings(
        token_hash_secret="a-test-secret-with-enough-length",
        cors_allowed_origins=" https://app.example.com, http://localhost:5173 ,,",
    )

    assert settings.cors_origins == ["https://app.example.com", "http://localhost:5173"]
