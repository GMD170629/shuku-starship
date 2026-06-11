from __future__ import annotations

import fnmatch
import os
import queue
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from app.core.config import Settings
from app.worker.importer import ImportOptions, import_managed_book, is_supported_import_file
from app.worker.path_security import PathSecurityService

RESCAN_REQUESTED_AT_KEY = "monitor.rescanRequestedAt"
RESCAN_HANDLED_AT_KEY = "monitor.rescanHandledAt"


@dataclass(frozen=True)
class MonitorFolderConfig:
    id: str
    root_path: str
    import_mode: str = "COPY"
    ignore_hidden: bool = True
    ignore_patterns: str | None = None
    min_file_size_bytes: int = 10240


@dataclass
class WatchState:
    observer: Observer
    root_path: Path
    config_signature: str
    timers: dict[Path, threading.Timer] = field(default_factory=dict)


class ImportQueue:
    def __init__(self, db_factory, settings: Settings) -> None:
        self.db_factory = db_factory
        self.settings = settings
        self._queue: queue.Queue[tuple[Path, MonitorFolderConfig] | None] = queue.Queue()
        self._queued_paths: set[Path] = set()
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._run, name="shuku-import-queue", daemon=True)
        self._thread.start()

    def enqueue(self, path: Path, folder: MonitorFolderConfig) -> None:
        real = path.resolve()
        with self._lock:
            if real in self._queued_paths:
                return
            self._queued_paths.add(real)
        self._queue.put((real, folder))

    def stop(self) -> None:
        self._queue.put(None)
        self._thread.join(timeout=10)

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                return
            path, folder = item
            try:
                with self.db_factory() as db:
                    import_watched_file(db, self.settings, path, folder)
            except Exception as exc:
                print(f"[import-worker] watched import failed {path}: {exc}", flush=True)
            finally:
                with self._lock:
                    self._queued_paths.discard(path)
                self._queue.task_done()


class WorkerFileHandler(FileSystemEventHandler):
    def __init__(self, manager: "WorkerManager", folder: MonitorFolderConfig, state: WatchState) -> None:
        self.manager = manager
        self.folder = folder
        self.state = state

    def on_created(self, event: FileSystemEvent) -> None:
        self._schedule(event)

    def on_modified(self, event: FileSystemEvent) -> None:
        self._schedule(event)

    def _schedule(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        self.manager.schedule_import(Path(event.src_path), self.folder, self.state)


class WorkerManager:
    def __init__(self, db_factory, settings: Settings) -> None:
        self.db_factory = db_factory
        self.settings = settings
        self.security = PathSecurityService(settings)
        self.stable_delay_seconds = int(os.environ.get("MONITOR_FILE_STABLE_DELAY_MS") or "2000") / 1000
        self.watchers: dict[str, WatchState] = {}
        self.import_queue = ImportQueue(db_factory, settings)
        self.last_handled_rescan_request: str | None = None

    def refresh_worker_state(self) -> None:
        with self.db_factory() as db:
            self.refresh_watchers(db)
            self.process_rescan_requests(db)

    def refresh_watchers(self, db: Session) -> None:
        folders = enabled_monitor_folders(db)
        active_ids = {folder.id for folder in folders}
        for folder_id, state in list(self.watchers.items()):
            folder = next((item for item in folders if item.id == folder_id), None)
            if folder_id not in active_ids or (folder and state.config_signature != config_signature(folder)):
                self._stop_watcher(folder_id)

        for folder in folders:
            if folder.id in self.watchers:
                continue
            try:
                real_path = self.security.validate_monitor_folder(folder.root_path).real_path
            except Exception as exc:
                print(f"[import-worker] monitor folder unavailable {folder.root_path}: {exc}", flush=True)
                continue
            observer = Observer()
            state = WatchState(observer=observer, root_path=real_path, config_signature=config_signature(folder))
            observer.schedule(WorkerFileHandler(self, folder, state), str(real_path), recursive=True)
            observer.start()
            self.watchers[folder.id] = state
            print(f"[import-worker] monitoring {real_path}", flush=True)
            scan_directory_for_imports(real_path, folder, self.import_queue)

    def process_rescan_requests(self, db: Session) -> None:
        try:
            settings = {row["key"]: row["value"] for row in db.execute(text("SELECT `key`, `value` FROM `SystemSetting` WHERE `key` IN (:requested, :handled)"), {"requested": RESCAN_REQUESTED_AT_KEY, "handled": RESCAN_HANDLED_AT_KEY}).mappings()}
        except SQLAlchemyError as exc:
            print(f"[import-worker] system settings unavailable, retrying later: {exc}", flush=True)
            return
        requested_at = settings.get(RESCAN_REQUESTED_AT_KEY)
        handled_at = settings.get(RESCAN_HANDLED_AT_KEY)
        if not requested_at or requested_at == handled_at or requested_at == self.last_handled_rescan_request:
            return
        print(f"[import-worker] rescan requested at {requested_at}", flush=True)
        for folder in enabled_monitor_folders(db):
            try:
                real_path = self.security.validate_monitor_folder(folder.root_path).real_path
            except Exception as exc:
                print(f"[import-worker] rescan monitor folder unavailable {folder.root_path}: {exc}", flush=True)
                continue
            scan_directory_for_imports(real_path, folder, self.import_queue)
        self.last_handled_rescan_request = requested_at
        upsert_system_setting(db, RESCAN_HANDLED_AT_KEY, requested_at)

    def schedule_import(self, path: Path, folder: MonitorFolderConfig, state: WatchState) -> None:
        if should_ignore_file(path, folder):
            return
        existing = state.timers.pop(path, None)
        if existing:
            existing.cancel()
        timer = threading.Timer(self.stable_delay_seconds, lambda: self.import_queue.enqueue(path, folder))
        state.timers[path] = timer
        timer.start()

    def shutdown(self) -> None:
        for folder_id in list(self.watchers):
            self._stop_watcher(folder_id)
        self.import_queue.stop()

    def _stop_watcher(self, folder_id: str) -> None:
        state = self.watchers.pop(folder_id, None)
        if not state:
            return
        for timer in state.timers.values():
            timer.cancel()
        state.observer.stop()
        state.observer.join(timeout=10)
        print(f"[import-worker] stopped monitor {state.root_path}", flush=True)


def enabled_monitor_folders(db: Session) -> list[MonitorFolderConfig]:
    try:
        rows = db.execute(text("SELECT * FROM `MonitorFolder` WHERE `enabled` = 1 ORDER BY `createdAt` DESC")).mappings().all()
    except SQLAlchemyError as exc:
        print(f"[import-worker] monitor folders unavailable, retrying later: {exc}", flush=True)
        return []
    return [
        MonitorFolderConfig(
            id=row["id"],
            root_path=row["rootPath"],
            import_mode=row.get("importMode") or "COPY",
            ignore_hidden=bool(row.get("ignoreHidden", True)),
            ignore_patterns=row.get("ignorePatterns"),
            min_file_size_bytes=int(row.get("minFileSizeBytes") or 10240),
        )
        for row in rows
    ]


def parse_ignore_patterns(value: str | None) -> list[str]:
    return [line.strip() for line in (value or "").splitlines() if line.strip()]


def should_ignore_path(path: Path, folder: MonitorFolderConfig) -> bool:
    if folder.ignore_hidden and any(part.startswith(".") and len(part) > 1 for part in path.parts):
        return True
    return any(fnmatch.fnmatch(path.name, pattern) or pattern.replace("*", "") in path.name for pattern in parse_ignore_patterns(folder.ignore_patterns))


def should_ignore_file(path: Path, folder: MonitorFolderConfig) -> bool:
    return should_ignore_path(path, folder) or not is_supported_import_file(path)


def config_signature(folder: MonitorFolderConfig) -> str:
    return "|".join([folder.root_path, folder.import_mode, str(folder.ignore_hidden), folder.ignore_patterns or "", str(folder.min_file_size_bytes)])


def wait_for_stable_file(path: Path, min_file_size_bytes: int, delay_seconds: float = 2.0) -> bool:
    try:
        before = path.stat()
    except OSError:
        return False
    if not path.is_file() or before.st_size < min_file_size_bytes:
        return False
    time.sleep(delay_seconds)
    try:
        after = path.stat()
    except OSError:
        return False
    return after.st_size == before.st_size and after.st_mtime_ns == before.st_mtime_ns


def import_watched_file(db: Session, settings: Settings, path: Path, folder: MonitorFolderConfig) -> None:
    delay = int(os.environ.get("MONITOR_FILE_STABLE_DELAY_MS") or "2000") / 1000
    if not wait_for_stable_file(path, folder.min_file_size_bytes, delay):
        return
    existing = db.execute(
        text("SELECT `id` FROM `ImportTask` WHERE `origin` = 'WATCH' AND `monitorFolderId` = :folder_id AND `sourcePath` = :source_path AND `status` = 'COMPLETED' LIMIT 1"),
        {"folder_id": folder.id, "source_path": str(path)},
    ).mappings().first()
    if existing:
        print(f"[import-worker] skipped already imported file {path}", flush=True)
        return
    import_managed_book(db, settings, ImportOptions(source_file_path=path, original_name=path.name, origin="WATCH", monitor_folder_id=folder.id, import_mode=folder.import_mode))


def scan_directory_for_imports(root_path: Path, folder: MonitorFolderConfig, import_queue: ImportQueue) -> None:
    try:
        entries = list(root_path.iterdir())
    except OSError as exc:
        print(f"[import-worker] rescan directory failed {root_path}: {exc}", flush=True)
        return
    for entry in entries:
        if entry.is_dir():
            if not should_ignore_path(entry, folder):
                scan_directory_for_imports(entry, folder, import_queue)
            continue
        if entry.is_file() and not should_ignore_file(entry, folder):
            import_queue.enqueue(entry, folder)


def upsert_system_setting(db: Session, key: str, value: str) -> None:
    existing = db.execute(text("SELECT `key` FROM `SystemSetting` WHERE `key` = :key"), {"key": key}).first()
    if existing:
        db.execute(text("UPDATE `SystemSetting` SET `value` = :value WHERE `key` = :key"), {"key": key, "value": value})
    else:
        db.execute(text("INSERT INTO `SystemSetting` (`key`, `value`, `createdAt`, `updatedAt`) VALUES (:key, :value, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"), {"key": key, "value": value})
    db.commit()
