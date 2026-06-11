from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import Settings, get_settings
from app.db.base import Base
from app.db.session import get_db
from app.main import create_app
from app.models import auth, settings  # noqa: F401


@pytest.fixture()
def test_settings(tmp_path) -> Settings:
    return Settings(
        database_url="sqlite+pysqlite:///:memory:",
        session_secret="test-secret",
        monitor_root=str(tmp_path / "monitor"),
        storage_root=str(tmp_path / "storage"),
        download_inbox_path=str(tmp_path / "downloads" / "inbox"),
        secure_cookies=False,
        automatic_backup_enabled=False,
        download_queue_enabled=False,
    )


@pytest.fixture()
def db_session(test_settings: Settings) -> Generator[Session, None, None]:
    engine = create_engine(
        test_settings.database_url,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    TestingSessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


@pytest.fixture()
def client(test_settings: Settings, db_session: Session) -> Generator[TestClient, None, None]:
    app = create_app(test_settings)

    def override_settings() -> Settings:
        return test_settings

    def override_db() -> Generator[Session, None, None]:
        yield db_session

    app.dependency_overrides[get_settings] = override_settings
    app.dependency_overrides[get_db] = override_db
    with TestClient(app) as test_client:
        yield test_client
