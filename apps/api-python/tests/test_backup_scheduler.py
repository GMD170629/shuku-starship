from threading import Event

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.services import backup_scheduler


class FakeSession:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


def test_app_lifespan_starts_automatic_backup_scheduler(monkeypatch, tmp_path):
    ran = Event()
    sessions: list[FakeSession] = []

    def session_factory() -> FakeSession:
        session = FakeSession()
        sessions.append(session)
        return session

    def fake_ensure_automatic_backup(db, settings):
        assert isinstance(db, FakeSession)
        assert settings.automatic_backup_enabled is True
        ran.set()
        return None

    monkeypatch.setattr(backup_scheduler, "ensure_automatic_backup", fake_ensure_automatic_backup)
    settings = Settings(
        database_url="sqlite+pysqlite:///:memory:",
        session_secret="test-secret",
        storage_root=str(tmp_path / "storage"),
        automatic_backup_enabled=True,
        automatic_backup_check_on_startup=True,
        automatic_backup_interval_seconds=60,
    )
    app = create_app(settings, session_factory=session_factory)

    with TestClient(app):
        assert ran.wait(2)

    assert sessions
    assert sessions[0].closed is True
