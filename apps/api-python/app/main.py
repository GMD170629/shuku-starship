from collections.abc import Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy.orm import Session

from app.api.router import api_router
from app.core.config import Settings, get_settings
from app.db.session import SessionLocal
from app.services.backup_scheduler import start_automatic_backup_scheduler


def create_app(settings_override: Settings | None = None, session_factory: Callable[[], Session] | None = None) -> FastAPI:
    settings = settings_override or get_settings()
    factory = session_factory or SessionLocal

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        scheduler = start_automatic_backup_scheduler(factory, settings)
        app.state.automatic_backup_scheduler = scheduler
        try:
            yield
        finally:
            if scheduler is not None:
                scheduler.stop()

    app = FastAPI(title=settings.app_name, version=settings.app_version, lifespan=lifespan)
    app.include_router(api_router, prefix="/api")
    return app


app = create_app()
