from __future__ import annotations

from collections.abc import Callable
from threading import Event, Thread

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.services.backup_service import ensure_automatic_backup


SessionFactory = Callable[[], Session]


def run_automatic_backup_once(session_factory: SessionFactory, settings: Settings) -> bool:
    db = session_factory()
    try:
        return ensure_automatic_backup(db, settings) is not None
    finally:
        db.close()


class AutomaticBackupScheduler:
    def __init__(self, session_factory: SessionFactory, settings: Settings) -> None:
        self.session_factory = session_factory
        self.settings = settings
        self._stop = Event()
        self._thread: Thread | None = None
        self.last_error: str | None = None

    def start(self) -> None:
        if not self.settings.automatic_backup_enabled or self._thread is not None:
            return
        self._thread = Thread(target=self._run, name="automatic-backup-scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def _safe_run_once(self) -> None:
        try:
            run_automatic_backup_once(self.session_factory, self.settings)
            self.last_error = None
        except Exception as exc:
            self.last_error = str(exc)[:500]

    def _run(self) -> None:
        if self.settings.automatic_backup_check_on_startup:
            self._safe_run_once()
        interval = self.settings.automatic_backup_interval_seconds
        while not self._stop.wait(interval):
            self._safe_run_once()


def start_automatic_backup_scheduler(session_factory: SessionFactory, settings: Settings) -> AutomaticBackupScheduler | None:
    if not settings.automatic_backup_enabled:
        return None
    scheduler = AutomaticBackupScheduler(session_factory, settings)
    scheduler.start()
    return scheduler
