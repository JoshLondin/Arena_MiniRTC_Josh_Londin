from __future__ import annotations

import hashlib
import hmac
import secrets

from app.core.config import settings


def generate_opaque_token() -> str:
    return secrets.token_urlsafe(32)


def generate_room_code(length: int | None = None) -> str:
    size = length or settings.room_code_length
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
    return "".join(secrets.choice(alphabet) for _ in range(size))


def hash_token(raw_token: str) -> str:
    return hmac.new(
        settings.token_hash_secret.encode("utf-8"),
        raw_token.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def verify_token(raw_token: str, token_hash: str) -> bool:
    return hmac.compare_digest(hash_token(raw_token), token_hash)

