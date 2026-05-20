from __future__ import annotations

from app.services import ice_service as ice_service_module
from app.services.ice_service import IceService


class StubSettings:
    stun_server_url = "stun:stun.example.com:19302"
    turn_server_url = "turn:turn.example.com:3478"
    turn_username = "alice"
    turn_password = "secret"


def test_ice_service_returns_stun_and_turn_when_turn_is_configured(monkeypatch) -> None:
    monkeypatch.setattr(ice_service_module, "settings", StubSettings())

    assert IceService().get_ice_servers() == [
        {"urls": ["stun:stun.example.com:19302"]},
        {
            "urls": ["turn:turn.example.com:3478"],
            "username": "alice",
            "credential": "secret",
        },
    ]
