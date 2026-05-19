from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes.rooms import router as rooms_router
from app.api.routes.signaling import router as signaling_router
from app.core.background_tasks import start_cleanup_tasks, stop_cleanup_tasks
from app.core.config import settings
from app.core.errors import install_error_handlers


@asynccontextmanager
async def lifespan(app: FastAPI):
    tasks = start_cleanup_tasks()
    try:
        yield
    finally:
        await stop_cleanup_tasks(tasks)


def create_app() -> FastAPI:
    app = FastAPI(title="MiniRTC API", lifespan=lifespan)
    install_error_handlers(app)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(rooms_router)
    app.include_router(signaling_router)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
