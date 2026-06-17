from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.services.download_executor import execute_download_task, has_table


class DownloadQueueWorker:
    def __init__(self, db_factory: Callable[[], Session], settings: Settings) -> None:
        self.db_factory = db_factory
        self.settings = settings
        self._stop_event = threading.Event()
        self._process_lock = threading.Lock()
        self._thread = threading.Thread(target=self._run, name="shuku-download-queue", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        self._thread.join(timeout=10)

    def process_once(self) -> bool:
        if not self._process_lock.acquire(blocking=False):
            return False
        try:
            with self.db_factory() as db:
                return process_next_download_task(db, self.settings)
        except Exception as exc:
            print(f"[download-queue] task processing failed: {exc}", flush=True)
            return False
        finally:
            self._process_lock.release()

    def _run(self) -> None:
        while not self._stop_event.is_set():
            processed = self.process_once()
            if processed:
                continue
            self._stop_event.wait(self.settings.download_queue_interval_seconds)


def next_queued_task(db: Session) -> dict[str, Any] | None:
    try:
        if not has_table(db, "DownloadTask"):
            return None
        row = db.execute(
            text("SELECT * FROM `DownloadTask` WHERE `status` = 'queued' ORDER BY `createdAt` ASC LIMIT 1")
        ).mappings().first()
        return dict(row) if row else None
    except SQLAlchemyError as exc:
        print(f"[download-queue] download task table unavailable, retrying later: {exc}", flush=True)
        return None


def process_next_download_task(db: Session, settings: Settings) -> bool:
    task = next_queued_task(db)
    if not task:
        return False
    result = execute_download_task(db, settings, str(task["id"]))
    if result.task.get("status") == "downloaded":
        print(f"[download-queue] downloaded {task['id']} to monitored folder; watcher will import it", flush=True)
    return True


def start_download_queue_worker(db_factory: Callable[[], Session], settings: Settings) -> DownloadQueueWorker | None:
    if not settings.download_queue_enabled:
        return None
    worker = DownloadQueueWorker(db_factory, settings)
    worker.start()
    return worker
