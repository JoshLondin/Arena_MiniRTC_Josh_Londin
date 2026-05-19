from __future__ import annotations

from app.core.config import settings


class IceService:
    def get_ice_servers(self) -> list[dict[str, str | list[str]]]:
        servers: list[dict[str, str | list[str]]] = [{"urls": [settings.stun_server_url]}]
        if settings.turn_server_url and settings.turn_username and settings.turn_password:
            servers.append(
                {
                    "urls": [settings.turn_server_url],
                    "username": settings.turn_username,
                    "credential": settings.turn_password,
                }
            )
        return servers

