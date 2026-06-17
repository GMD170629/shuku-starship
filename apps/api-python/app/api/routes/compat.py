from __future__ import annotations

import hashlib
import json
import logging
import mimetypes
import os
import re
import shutil
import threading
import zipfile
from datetime import datetime, timezone
from email.utils import format_datetime, parsedate_to_datetime
from pathlib import Path
from time import monotonic, time_ns
from typing import Any
from urllib.parse import quote, urlencode
from urllib.request import Request as UrlRequest
from urllib.request import urlopen

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.config import Settings, get_settings
from app.db.session import get_db
from app.models.auth import User
from app.schemas.responses import fail, ok
from app.services.backup_service import create_backup as create_backup_archive
from app.services.backup_service import list_backups as list_backup_archives
from app.services.backup_service import restore_backup as restore_backup_archive
from app.services.download_executor import (
    create_remote_ref_from_search_record,
    execute_download_task,
    find_active_download_task,
    has_usable_download_meta,
    import_download_task,
    infer_download_task_type,
)
from app.services.health import run_system_health_checks
from app.services.organize_service import (
    apply_organize_job,
    bulk_apply_organize_jobs as apply_organize_jobs_bulk,
    context_for_job,
    ensure_organize_job_for_work,
    metadata_search_candidates,
    normalize_key,
    refresh_metadata_providers,
    refresh_organize_job,
)
from app.services.source_providers import PROVIDER_CAPABILITIES, search_source_provider, test_source_provider
from app.worker.importer import ImportOptions, import_managed_book, is_supported_import_file, parse_comic_archive, parse_series_volume_info

router = APIRouter()
logger = logging.getLogger(__name__)
_active_file_streams_by_user: dict[str, int] = {}
_active_file_streams_lock = threading.Lock()
STREAMS_PER_USER_LIMIT = 4
SLOW_REQUEST_LOG_THRESHOLD_MS = 1500


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _positive_env_int(name: str, fallback: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return fallback
    return value if value >= 0 else fallback


def _has_table(db: Session, table: str) -> bool:
    try:
        return table in inspect(db.get_bind()).get_table_names()
    except Exception:
        return False


def _has_column(db: Session, table: str, column: str) -> bool:
    try:
        return any(item.get("name") == column for item in inspect(db.get_bind()).get_columns(table))
    except Exception:
        return False


def _auth(db: Session, request: Request, settings: Settings) -> tuple[User | None, Response | None]:
    user, _token, _refresh = get_current_user(db, request, settings)
    if user is None:
        return None, fail("UNAUTHORIZED", status_code=401)
    return user, None


def _rows(db: Session, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    return [_normalize_row(dict(row)) for row in db.execute(text(sql), params or {}).mappings().all()]


def _row(db: Session, sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
    result = db.execute(text(sql), params or {}).mappings().first()
    return _normalize_row(dict(result)) if result else None


def _normalize_row(row: dict[str, Any]) -> dict[str, Any]:
    boolean_keys = {
        "enabled",
        "ignoreHidden",
        "downloadAvailable",
        "duplicate",
        "primary",
        "hidden",
        "organized",
    }
    for key in boolean_keys & row.keys():
        if row[key] in (0, 1):
            row[key] = bool(row[key])
    return row


def _scalar(db: Session, sql: str, params: dict[str, Any] | None = None, default: Any = 0) -> Any:
    try:
        value = db.execute(text(sql), params or {}).scalar()
        return default if value is None else value
    except Exception:
        return default


def _table_count(db: Session, table: str, where: str = "", params: dict[str, Any] | None = None) -> int:
    if not _has_table(db, table):
        return 0
    suffix = f" WHERE {where}" if where else ""
    return int(_scalar(db, f"SELECT COUNT(*) FROM `{table}`{suffix}", params, 0))


def _parse_json(value: Any, fallback: Any) -> Any:
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except Exception:
        return fallback


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _nullable_float(value: Any, field_label: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field_label}格式不正确") from None


def _nullable_int(value: Any, field_label: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    try:
        parsed = float(value) if isinstance(value, str) else value
        if int(parsed) != parsed:
            raise ValueError
        return int(parsed)
    except (TypeError, ValueError):
        raise ValueError(f"{field_label}格式不正确") from None


SOURCE_PROVIDER_LABELS = {
    "manual": "手动源",
    "http": "HTTP",
    "pt_rss": "PT RSS",
    "zlibrary": "Z-Library",
    "rss": "RSS",
    "comic_api": "漫画 API",
}

SOURCE_KIND_LABELS = {
    "novel": "小说",
    "comic": "漫画",
    "mixed": "混合",
    "metadata": "元数据",
    "search": "搜索",
}

MASKED_SECRET = "********"


def _masked_secret(value: Any) -> dict[str, Any] | None:
    return {"configured": True, "masked": MASKED_SECRET} if isinstance(value, str) and value.strip() else None


def _is_masked_secret(value: Any) -> bool:
    if isinstance(value, dict):
        return value.get("configured") is True
    return isinstance(value, str) and value.strip() == MASKED_SECRET


def _source_config_for_client(source: dict[str, Any]) -> dict[str, Any]:
    config = _parse_json(source.get("config"), {})
    if not isinstance(config, dict):
        return {}
    if source.get("providerType") == "zlibrary" and config.get("password"):
        config = {**config, "password": _masked_secret(config.get("password"))}
    return config


def _source_view(source: dict[str, Any]) -> dict[str, Any]:
    provider_type = source.get("providerType") or "manual"
    kind = source.get("kind") or "mixed"
    return {
        **source,
        "config": _source_config_for_client(source),
        "capabilities": _parse_json(source.get("capabilities"), {}),
        "rateLimit": _parse_json(source.get("rateLimit"), {}),
        "providerTypeLabel": SOURCE_PROVIDER_LABELS.get(provider_type, str(provider_type)),
        "kindLabel": SOURCE_KIND_LABELS.get(kind, str(kind)),
    }


def _merge_source_config_for_write(existing: dict[str, Any] | None, provider_type: str, incoming: Any) -> Any:
    config = _parse_json(incoming, {}) if not isinstance(incoming, dict) else incoming
    if not isinstance(config, dict):
        return config
    if provider_type != "zlibrary":
        return config
    password = config.get("password")
    if password is None or password == "" or _is_masked_secret(password):
        existing_config = _parse_json((existing or {}).get("config"), {})
        if isinstance(existing_config, dict) and existing_config.get("password"):
            return {**config, "password": existing_config.get("password")}
        return {key: value for key, value in config.items() if key != "password"}
    return config


def _positive_int(value: Any, fallback: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    if parsed < 1:
        return fallback
    return min(parsed, maximum)


def _safe_upload_name(value: str | None) -> str:
    name = Path(value or "upload").name
    sanitized = re.sub(r"[^A-Za-z0-9._()（）\-\u4e00-\u9fff]+", "_", name).strip("._")
    return sanitized or "upload"


def _dt(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _cover_url(kind: str, row_id: str, row: dict[str, Any] | None = None, **params: Any) -> str:
    query = {key: value for key, value in params.items() if value is not None}
    version_source = ""
    if row:
        version_source = "|".join([str(row.get("coverPath") or ""), _dt(row.get("updatedAt")) or ""])
    if version_source.strip("|"):
        query["v"] = hashlib.sha1(version_source.encode("utf-8")).hexdigest()[:12]
    suffix = f"?{urlencode(query)}" if query else ""
    return f"/api/{kind}/{row_id}/cover{suffix}"


def _format_bytes(value: Any) -> str:
    try:
        size = float(value or 0)
    except (TypeError, ValueError):
        size = 0
    if size <= 0:
        return "0 B"
    units = ["B", "KB", "MB", "GB", "TB"]
    index = 0
    while size >= 1024 and index < len(units) - 1:
        size /= 1024
        index += 1
    return f"{size:.0f} {units[index]}" if index == 0 else f"{size:.1f} {units[index]}"


def _system_event_size_bytes(db: Session) -> int:
    if not _has_table(db, "SystemEvent"):
        return 0
    return int(
        _scalar(
            db,
            """
            SELECT COALESCE(SUM(
                LENGTH(COALESCE(`id`, '')) +
                LENGTH(COALESCE(`level`, '')) +
                LENGTH(COALESCE(`source`, '')) +
                LENGTH(COALESCE(`actorType`, '')) +
                LENGTH(COALESCE(`actorId`, '')) +
                LENGTH(COALESCE(`action`, '')) +
                LENGTH(COALESCE(`targetType`, '')) +
                LENGTH(COALESCE(`targetId`, '')) +
                LENGTH(COALESCE(`message`, '')) +
                LENGTH(COALESCE(`metadata`, ''))
            ), 0) FROM `SystemEvent`
            """,
            default=0,
        )
        or 0
    )


def _prune_system_events(db: Session, max_bytes: int = 5 * 1024 * 1024) -> dict[str, Any]:
    if not _has_table(db, "SystemEvent"):
        return {"deleted": 0, "sizeBytes": 0, "maxBytes": max_bytes}
    deleted = 0
    for level in ("info", "warning", "warn", "error"):
        while _system_event_size_bytes(db) > max_bytes:
            if level == "error":
                rows = _rows(
                    db,
                    "SELECT `id` FROM `SystemEvent` WHERE `level` = :level AND `action` NOT IN ('deleted', 'restored', 'settings.updated', 'backup.restored') ORDER BY `createdAt` ASC LIMIT 100",
                    {"level": level},
                )
            else:
                rows = _rows(db, "SELECT `id` FROM `SystemEvent` WHERE `level` = :level ORDER BY `createdAt` ASC LIMIT 100", {"level": level})
            ids = [row.get("id") for row in rows if row.get("id")]
            if not ids:
                break
            params = {f"id_{index}": item for index, item in enumerate(ids)}
            placeholders = ", ".join(f":id_{index}" for index in range(len(ids)))
            result = db.execute(text(f"DELETE FROM `SystemEvent` WHERE `id` IN ({placeholders})"), params)
            db.commit()
            deleted += result.rowcount or 0
    size_bytes = _system_event_size_bytes(db)
    if deleted and _has_table(db, "SystemSetting"):
        now = _now()
        existing = _row(db, "SELECT `key` FROM `SystemSetting` WHERE `key` = :key", {"key": "events.lastPrunedAt"})
        if existing:
            db.execute(text("UPDATE `SystemSetting` SET `value` = :value, `updatedAt` = :now WHERE `key` = :key"), {"key": "events.lastPrunedAt", "value": now.isoformat(), "now": now})
        else:
            db.execute(text("INSERT INTO `SystemSetting` (`key`, `value`, `createdAt`, `updatedAt`) VALUES (:key, :value, :now, :now)"), {"key": "events.lastPrunedAt", "value": now.isoformat(), "now": now})
        db.commit()
    return {"deleted": deleted, "sizeBytes": size_bytes, "maxBytes": max_bytes}


def _record_system_event(
    db: Session,
    *,
    level: str = "info",
    source: str,
    action: str,
    message: str,
    actor_type: str = "system",
    actor_id: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    if not _has_table(db, "SystemEvent"):
        return
    safe_level = "warning" if level == "warn" else level
    _insert(
        db,
        "SystemEvent",
        {
            "id": f"py_{time_ns()}",
            "level": safe_level if safe_level in {"info", "warning", "error"} else "info",
            "source": source,
            "actorType": actor_type,
            "actorId": actor_id,
            "action": action,
            "targetType": target_type,
            "targetId": target_id,
            "message": message,
            "metadata": _json_text(metadata or {}),
            "createdAt": _now(),
        },
    )
    _prune_system_events(db)


def _coerce_int(value: Any, fallback: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return fallback


def _raw_progress_percent(progress: dict[str, Any] | None) -> int:
    return max(0, min(100, round(float(progress.get("percent", 0) if progress else 0))))


def _display_progress_percent(edition: dict[str, Any] | None, progress: dict[str, Any] | None, volumes: list[dict[str, Any]]) -> int:
    return _raw_progress_percent(progress)


def _latest_progress(progresses: list[dict[str, Any]]) -> dict[str, Any] | None:
    return next(iter(sorted(progresses, key=lambda item: _dt(item.get("updatedAt")) or "", reverse=True)), None)


def _progress_for_volume(progresses: list[dict[str, Any]], volume_id: str | None) -> dict[str, Any] | None:
    if volume_id:
        specific = next((item for item in progresses if item.get("volumeId") == volume_id), None)
        if specific:
            return specific
    return next((item for item in progresses if not item.get("volumeId")), None)


def _choose_continue_volume(volumes: list[dict[str, Any]], progresses: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not volumes:
        return None
    progress_by_volume = {volume["id"]: _raw_progress_percent(_progress_for_volume(progresses, volume["id"])) for volume in volumes}
    for volume in volumes:
        percent = progress_by_volume.get(volume["id"], 0)
        if 0 < percent < 100:
            return volume
    for volume in volumes:
        if progress_by_volume.get(volume["id"], 0) <= 0:
            return volume
    return volumes[-1]


def _empty_progress_for_volume(edition: dict[str, Any] | None, volume: dict[str, Any] | None) -> dict[str, Any] | None:
    if not edition or not volume:
        return None
    return {"editionId": edition.get("id"), "workId": edition.get("workId"), "volumeId": volume.get("id"), "position": "0", "page": None, "percent": 0, "extra": "{}", "updatedAt": None}


def _continue_progress_for_edition(edition: dict[str, Any] | None, progresses: list[dict[str, Any]], volumes: list[dict[str, Any]]) -> dict[str, Any] | None:
    if edition and edition.get("format") in {"EPUB", "COMIC"} and len(volumes) > 1:
        volume = _choose_continue_volume(volumes, progresses)
        volume_progress = _progress_for_volume(progresses, volume.get("id") if volume else None)
        return volume_progress or _empty_progress_for_volume(edition, volume)
    return _latest_progress(progresses)


def _progress_chapter_label(progress: dict[str, Any] | None, volumes: list[dict[str, Any]]) -> str:
    if not progress or not progress.get("page"):
        return "未开始"
    volume_id = progress.get("volumeId")
    volume = next((item for item in volumes if item.get("id") == volume_id), None) if volume_id else None
    prefix = f"{volume.get('title') or '未命名卷'} · " if volume and len(volumes) > 1 else ""
    return f"{prefix}第 {progress.get('page')} 页"


def _labels() -> dict[str, dict[str, str]]:
    return {
        "format": {"EPUB": "EPUB", "COMIC": "漫画"},
        "status": {"WANT": "想读", "READING": "在读", "FINISHED": "已读"},
        "publication": {"UNKNOWN": "未知", "ONGOING": "连载中", "COMPLETED": "已完结", "HIATUS": "休刊", "CANCELLED": "已取消"},
        "tracking": {"NOT_TRACKING": "未追踪", "TRACKING": "追踪中", "PAUSED": "已暂停", "IGNORED": "已忽略"},
    }


def _work_view(db: Session, work: dict[str, Any], user_id: str | None = None) -> dict[str, Any]:
    editions = []
    files_by_edition: dict[str, list[dict[str, Any]]] = {}
    volumes_by_edition: dict[str, list[dict[str, Any]]] = {}
    progresses_by_edition: dict[str, list[dict[str, Any]]] = {}
    if _has_table(db, "LibraryEdition"):
        editions = _rows(
            db,
            "SELECT * FROM `LibraryEdition` WHERE `workId` = :work_id AND `hidden` = 0 ORDER BY `primary` DESC, `createdAt` ASC",
            {"work_id": work["id"]},
        )
    edition_ids = [item["id"] for item in editions]
    if edition_ids and _has_table(db, "LibraryFile"):
        for edition in editions:
            files_by_edition[edition["id"]] = _rows(
                db,
                "SELECT * FROM `LibraryFile` WHERE `editionId` = :edition_id ORDER BY `sortOrder` ASC",
                {"edition_id": edition["id"]},
            )
    if edition_ids and _has_table(db, "LibraryVolume"):
        for edition in editions:
            volumes_by_edition[edition["id"]] = _rows(
                db,
                "SELECT * FROM `LibraryVolume` WHERE `editionId` = :edition_id ORDER BY `sortOrder` ASC",
                {"edition_id": edition["id"]},
            )
    if edition_ids and user_id and _has_table(db, "LibraryReadingProgress"):
        for edition in editions:
            progresses = _rows(
                db,
                "SELECT * FROM `LibraryReadingProgress` WHERE `editionId` = :edition_id AND `userId` = :user_id ORDER BY `updatedAt` DESC",
                {"edition_id": edition["id"], "user_id": user_id},
            )
            if progresses:
                progresses_by_edition[edition["id"]] = progresses

    primary = next((item for item in editions if item["id"] == work.get("primaryEditionId")), None) or next((item for item in editions if item.get("primary")), None)
    display = primary or (editions[0] if editions else None)
    progress_by_edition = {
        edition["id"]: _continue_progress_for_edition(edition, progresses_by_edition.get(edition["id"], []), volumes_by_edition.get(edition["id"], []))
        for edition in editions
        if progresses_by_edition.get(edition["id"])
    }
    recent = sorted((item for item in progress_by_edition.values() if item), key=lambda item: _dt(item.get("updatedAt")) or "", reverse=True)
    progress = recent[0] if recent else (progress_by_edition.get(display["id"]) if display else None)
    progress_edition = next((item for item in editions if progress and item["id"] == progress.get("editionId")), None) or display
    progress_volumes = volumes_by_edition.get(progress_edition["id"], []) if progress_edition else []
    percent = _display_progress_percent(progress_edition, progress, progress_volumes)
    labels = _labels()
    total_size = sum(int(file.get("sizeBytes") or 0) for files in files_by_edition.values() for file in files)

    def volume_view(volume: dict[str, Any], progress_rows: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        volume_progress = _progress_for_volume(progress_rows or [], volume["id"])
        return {
            "id": volume["id"],
            "editionId": volume["editionId"],
            "title": volume.get("title") or "未命名卷",
            "volumeIndex": volume.get("volumeIndex"),
            "sortOrder": volume.get("sortOrder") or 0,
            "pageCount": volume.get("pageCount"),
            "chapterCount": volume.get("chapterCount"),
            "coverUrl": _cover_url("volumes", volume["id"], volume, workId=work["id"]),
            "progress": _raw_progress_percent(volume_progress),
            "lastReadAt": _dt(volume_progress.get("updatedAt")) if volume_progress else None,
            "position": volume_progress.get("position") if volume_progress else None,
            "currentPage": volume_progress.get("page") if volume_progress else None,
        }

    def file_view(file: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": file["id"],
            "path": file.get("path") or "",
            "mimeType": file.get("mimeType") or "application/octet-stream",
            "kind": file.get("kind") or work.get("workType"),
            "sortOrder": file.get("sortOrder") or 0,
            "size": _format_bytes(file.get("sizeBytes")),
        }

    edition_views = []
    for edition in editions:
        e_progress = progress_by_edition.get(edition["id"])
        e_progress_rows = progresses_by_edition.get(edition["id"], [])
        edition_files = files_by_edition.get(edition["id"], [])
        edition_volumes = [volume_view(volume, e_progress_rows) for volume in volumes_by_edition.get(edition["id"], [])]
        raw_edition_volumes = volumes_by_edition.get(edition["id"], [])
        edition_views.append(
            {
                "id": edition["id"],
                "workId": edition["workId"],
                "formatValue": edition.get("format") or work.get("workType"),
                "format": labels["format"].get(edition.get("format"), edition.get("format") or "未知"),
                "versionName": edition.get("versionName") or "默认版本",
                "primary": edition["id"] == work.get("primaryEditionId") or bool(edition.get("primary")),
                "hidden": bool(edition.get("hidden")),
                "size": _format_bytes(edition.get("sizeBytes")),
                "pageCount": edition.get("pageCount"),
                "chapterCount": edition.get("chapterCount"),
                "progress": _display_progress_percent(edition, e_progress, raw_edition_volumes),
                "lastReadAt": _dt(e_progress.get("updatedAt")) if e_progress else None,
                "coverUrl": _cover_url("editions", edition["id"], edition, size="medium"),
                "files": [file_view(file) for file in edition_files],
                "volumes": edition_volumes,
            }
        )

    first_files = files_by_edition.get(display["id"], []) if display else []
    first_file = first_files[0] if first_files else None
    volumes = [volume for edition in edition_views for volume in edition["volumes"]]
    work_type = work.get("workType") or (display.get("format") if display else "EPUB")
    return {
        "id": work["id"],
        "workId": work["id"],
        "editionId": display["id"] if display else None,
        "monitorFolderId": work.get("monitorFolderId"),
        "title": work.get("title") or "未命名作品",
        "author": work.get("author") or "未知作者",
        "publisher": display.get("publisher") if display else None,
        "type": "comic" if work_type == "COMIC" else "ebook",
        "formatValue": display.get("format") if display else work_type,
        "format": labels["format"].get(display.get("format") if display else work_type, "未知"),
        "size": _format_bytes(total_size or (display.get("sizeBytes") if display else 0)),
        "progress": percent,
        "statusValue": work.get("status") or "WANT",
        "status": labels["status"].get(work.get("status"), "想读"),
        "publicationStatusValue": work.get("publicationStatus") or "UNKNOWN",
        "publicationStatus": labels["publication"].get(work.get("publicationStatus"), "未知"),
        "trackingStatusValue": work.get("trackingStatus") or "NOT_TRACKING",
        "trackingStatus": labels["tracking"].get(work.get("trackingStatus"), "未追踪"),
        "localLatestVolume": work.get("localLatestVolume"),
        "localLatestChapter": work.get("localLatestChapter"),
        "localLatestTitle": work.get("localLatestTitle"),
        "localLatestAt": _dt(work.get("localLatestAt")),
        "ignored": bool(work.get("hidden")),
        "organized": bool(work.get("organized")),
        "organizeStatus": work.get("organizeStatus") or "REVIEWING",
        "metadataQuality": work.get("metadataQuality") or 0,
        "tags": _parse_json(work.get("tags"), []),
        "seriesName": work.get("seriesName"),
        "seriesIndex": work.get("seriesIndex"),
        "publishedYear": work.get("publishedYear"),
        "added": (_dt(work.get("createdAt")) or "")[:10],
        "lastRead": (_dt(progress.get("updatedAt")) or "")[:10] if progress else "尚未阅读",
        "lastReadAt": _dt(progress.get("updatedAt")) if progress else None,
        "chapter": _progress_chapter_label(progress, progress_volumes if progress_edition and progress_edition.get("format") == "COMIC" else []),
        "chapterCount": display.get("chapterCount") if display else None,
        "pageCount": display.get("pageCount") if display else None,
        "desc": work.get("description") or (display.get("description") if display else None) or "暂无简介，可在详情页补充元数据。",
        "path": first_file.get("path") if first_file else "",
        "fileHash": first_file.get("fullHash") if first_file else "",
        "gradient": "from-slate-950 via-blue-800 to-cyan-500",
        "coverStatus": work.get("coverStatus") or "PENDING",
        "coverUrl": _cover_url("works", work["id"], work, size="medium"),
        "totalUnits": (display.get("pageCount") if display and display.get("format") == "COMIC" else display.get("chapterCount")) if display else 0,
        "readingProgress": percent,
        "importStatus": display.get("importStatus") if display else "PENDING",
        "importError": display.get("importError") if display else None,
        "importedAt": _dt(work.get("createdAt")),
        "files": [file_view(file) for file in first_files],
        "versionCount": len(editions),
        "volumeCount": len(volumes),
        "primaryEditionId": work.get("primaryEditionId"),
        "primaryEditionName": primary.get("versionName") if primary else None,
        "recentEditionId": progress.get("editionId") if progress else (display["id"] if display else None),
        "recentVolumeId": progress.get("volumeId") if progress else None,
        "volumes": volumes,
        "editions": edition_views,
    }


def _get_work(db: Session, work_id: str) -> dict[str, Any] | None:
    if not _has_table(db, "LibraryWork"):
        return None
    return _row(db, "SELECT * FROM `LibraryWork` WHERE `id` = :id", {"id": work_id})


def _set_columns(db: Session, table: str) -> set[str]:
    if not _has_table(db, table):
        return set()
    return {column["name"] for column in inspect(db.get_bind()).get_columns(table)}


def _insert(db: Session, table: str, values: dict[str, Any]) -> dict[str, Any]:
    columns = _set_columns(db, table)
    values = {key: value for key, value in values.items() if key in columns}
    keys = ", ".join(f"`{key}`" for key in values)
    params = ", ".join(f":{key}" for key in values)
    db.execute(text(f"INSERT INTO `{table}` ({keys}) VALUES ({params})"), values)
    db.commit()
    id_key = "id" if "id" in values else "key"
    return _row(db, f"SELECT * FROM `{table}` WHERE `{id_key}` = :value", {"value": values[id_key]}) or values


def _update(db: Session, table: str, row_id: str, values: dict[str, Any], id_column: str = "id") -> dict[str, Any] | None:
    columns = _set_columns(db, table)
    values = {key: value for key, value in values.items() if key in columns and key != id_column}
    if values:
        values["row_id"] = row_id
        assignments = ", ".join(f"`{key}` = :{key}" for key in values if key != "row_id")
        db.execute(text(f"UPDATE `{table}` SET {assignments} WHERE `{id_column}` = :row_id"), values)
        db.commit()
    return _row(db, f"SELECT * FROM `{table}` WHERE `{id_column}` = :row_id", {"row_id": row_id})


def _delete(db: Session, table: str, row_id: str, id_column: str = "id") -> bool:
    if not _has_table(db, table):
        return False
    result = db.execute(text(f"DELETE FROM `{table}` WHERE `{id_column}` = :row_id"), {"row_id": row_id})
    db.commit()
    return bool(result.rowcount)


def _storage_managed_path(path_value: str | None, settings: Settings) -> Path | None:
    path = _stored_path(path_value, settings)
    if not path:
        return None
    try:
        storage = settings.resolved_storage_root.resolve()
        resolved = path.resolve()
    except OSError:
        return None
    if resolved == storage or storage in resolved.parents:
        return resolved
    return None


def _collect_work_storage_paths(db: Session, work_id: str, settings: Settings) -> list[Path]:
    paths: list[Path] = []

    def add(path_value: str | None) -> None:
        path = _storage_managed_path(path_value, settings)
        if path:
            paths.append(path)

    if _has_table(db, "LibraryWork"):
        work = _row(db, "SELECT `coverPath` FROM `LibraryWork` WHERE `id` = :work_id", {"work_id": work_id})
        add((work or {}).get("coverPath"))
    if not _has_table(db, "LibraryEdition"):
        return list(dict.fromkeys(paths))

    editions = _rows(db, "SELECT `id`, `coverPath` FROM `LibraryEdition` WHERE `workId` = :work_id", {"work_id": work_id})
    edition_ids = [edition["id"] for edition in editions]
    for edition in editions:
        add(edition.get("coverPath"))
    if not edition_ids:
        return list(dict.fromkeys(paths))

    for edition_id in edition_ids:
        if _has_table(db, "LibraryVolume"):
            volumes = _rows(db, "SELECT `coverPath` FROM `LibraryVolume` WHERE `editionId` = :edition_id", {"edition_id": edition_id})
            for volume in volumes:
                add(volume.get("coverPath"))
        if _has_table(db, "LibraryFile"):
            files = _rows(db, "SELECT `path` FROM `LibraryFile` WHERE `editionId` = :edition_id", {"edition_id": edition_id})
            for file in files:
                add(file.get("path"))
    return list(dict.fromkeys(paths))


def _delete_storage_paths(paths: list[Path], settings: Settings) -> dict[str, Any]:
    deleted: list[str] = []
    failed: list[dict[str, str]] = []
    storage = settings.resolved_storage_root.resolve()
    for path in paths:
        try:
            resolved = path.resolve()
            if resolved != storage and storage not in resolved.parents:
                continue
            if resolved.is_file() or resolved.is_symlink():
                resolved.unlink()
                deleted.append(str(resolved))
                parent = resolved.parent
                while parent != storage and storage in parent.parents:
                    try:
                        parent.rmdir()
                    except OSError:
                        break
                    parent = parent.parent
        except OSError as exc:
            failed.append({"path": str(path), "message": str(exc)})
            logger.warning("failed to delete managed storage file: %s", path, exc_info=exc)
    return {"deletedFiles": len(deleted), "failedFileDeletes": failed}


def _delete_work_and_storage(db: Session, work_id: str, settings: Settings) -> dict[str, Any]:
    paths = _collect_work_storage_paths(db, work_id, settings)
    deleted = _delete(db, "LibraryWork", work_id)
    cleanup = _delete_storage_paths(paths, settings) if deleted else {"deletedFiles": 0, "failedFileDeletes": []}
    return {"deleted": deleted, "id": work_id, **cleanup}


def _path_tree(paths: list[str], root_label: str) -> dict[str, Any]:
    root = {"name": root_label, "path": root_label, "type": "folder", "children": [], "fileCount": 0, "sizeBytes": 0}
    children_by_path: dict[str, dict[str, Any]] = {root_label: root}
    for raw_path in sorted({path for path in paths if path}):
        parts = [part for part in Path(raw_path).parts if part not in {"/", ""}]
        current = root
        current_path = root_label
        for index, part in enumerate(parts):
            current_path = f"{current_path}/{part}"
            node = children_by_path.get(current_path)
            if not node:
                node = {"name": part, "path": current_path, "type": "file" if index == len(parts) - 1 else "folder", "children": [], "fileCount": 0, "sizeBytes": 0}
                children_by_path[current_path] = node
                current["children"].append(node)
            current = node
            current["fileCount"] = int(current.get("fileCount") or 0) + (1 if index == len(parts) - 1 else 0)
    return root


def _source_folder_preview(root_path: str) -> dict[str, Any]:
    path = Path(root_path)
    readable = path.exists() and path.is_dir() and os.access(path, os.R_OK)
    writable = path.exists() and path.is_dir() and os.access(path, os.W_OK)
    children: list[dict[str, Any]] = []
    if readable:
        try:
            for child in sorted(path.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))[:80]:
                try:
                    stat = child.stat()
                    children.append({"name": child.name, "path": str(child), "type": "folder" if child.is_dir() else "file", "sizeBytes": 0 if child.is_dir() else stat.st_size, "mtimeMs": int(stat.st_mtime * 1000)})
                except OSError:
                    children.append({"name": child.name, "path": str(child), "type": "unknown", "sizeBytes": 0, "error": "无法读取"})
        except OSError:
            readable = False
    return {"readable": readable, "writable": writable, "children": children}


def _serialize_system_event(event: dict[str, Any]) -> dict[str, Any]:
    metadata = _parse_json(event.get("metadata"), {})
    return {
        "id": event.get("id"),
        "level": event.get("level") or "info",
        "source": event.get("source") or "system",
        "actorType": event.get("actorType") or "system",
        "actorId": event.get("actorId"),
        "action": event.get("action") or "",
        "targetType": event.get("targetType"),
        "targetId": event.get("targetId"),
        "message": event.get("message") or "",
        "metadata": metadata if isinstance(metadata, dict) else {},
        "createdAt": _dt(event.get("createdAt")),
    }


def _normalize_monitor_root_path(value: Any) -> str:
    root_path = str(value or "").strip()
    if not root_path:
        return ""
    return os.path.normpath(root_path)


def _monitor_folder_by_root_path(db: Session, root_path: str, exclude_id: str | None = None) -> dict[str, Any] | None:
    if not _has_table(db, "MonitorFolder"):
        return None
    params: dict[str, Any] = {"root_path": root_path}
    sql = "SELECT * FROM `MonitorFolder` WHERE `rootPath` = :root_path"
    if exclude_id is not None:
        sql += " AND `id` != :exclude_id"
        params["exclude_id"] = exclude_id
    return _row(db, f"{sql} LIMIT 1", params)


def _monitor_move_writable_error(root_path: str, import_mode: str | None) -> Response | None:
    if str(import_mode or "COPY").upper() != "MOVE":
        return None
    path = Path(root_path)
    if not path.exists() or not path.is_dir():
        return fail("移动模式需要监控文件夹在容器内存在", status_code=400, details={"rootPath": root_path})
    if not os.access(path, os.W_OK):
        return fail("移动模式需要监控文件夹可写；当前 /monitor 挂载可能是只读，请改用复制模式或将监控目录以可写方式挂载。", status_code=400, details={"rootPath": root_path, "importMode": "MOVE"})
    return None


@router.get("/dashboard/summary")
def dashboard_summary(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    total_books = _table_count(db, "LibraryWork", "`hidden` = 0")
    comic_books = _table_count(db, "LibraryWork", "`hidden` = 0 AND `workType` = 'COMIC'")
    novel_books = _table_count(db, "LibraryWork", "`hidden` = 0 AND `workType` = 'EPUB'")
    storage = _scalar(db, "SELECT COALESCE(SUM(`sizeBytes`), 0) FROM `LibraryEdition` WHERE `hidden` = 0", default=0) if _has_table(db, "LibraryEdition") else 0
    last_import = _row(db, "SELECT `finishedAt`, `updatedAt` FROM `ImportTask` WHERE `status` = 'COMPLETED' ORDER BY `finishedAt` DESC LIMIT 1") if _has_table(db, "ImportTask") else None
    latest_progress = _row(db, "SELECT `updatedAt` FROM `LibraryReadingProgress` ORDER BY `updatedAt` DESC LIMIT 1") if _has_table(db, "LibraryReadingProgress") else None
    return ok(
        {
            "totalBooks": total_books,
            "comicBooks": comic_books,
            "novelBooks": novel_books,
            "storageUsedBytes": int(storage or 0),
            "monitorFolderCount": _table_count(db, "MonitorFolder", "`enabled` = 1"),
            "lastImportAt": _dt((last_import or {}).get("finishedAt") or (last_import or {}).get("updatedAt")),
            "latestSyncAt": _dt((latest_progress or {}).get("updatedAt")),
        }
    )


@router.get("/dashboard/recent-books")
def dashboard_recent_books(request: Request, limit: int = 8, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    take = min(24, max(1, limit))
    works = _rows(db, "SELECT * FROM `LibraryWork` WHERE `hidden` = 0 ORDER BY `createdAt` DESC LIMIT :take", {"take": take}) if _has_table(db, "LibraryWork") else []
    return ok({"books": [_work_view(db, work, user.id) for work in works]})


@router.get("/dashboard/continue-reading")
def dashboard_continue_reading(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    progress = None
    if _has_table(db, "LibraryReadingProgress"):
        progress = _row(db, "SELECT * FROM `LibraryReadingProgress` WHERE `userId` = :user_id ORDER BY `updatedAt` DESC LIMIT 1", {"user_id": user.id})
    if not progress:
        return ok({"item": None})
    work = _get_work(db, progress["workId"])
    if not work or work.get("hidden"):
        return ok({"item": None})
    book = _work_view(db, work, user.id)
    return ok({"item": {"book": book, "progress": book.get("progress") or 0, "lastReadAt": _dt(progress.get("updatedAt")), "chapter": book.get("chapter") if book.get("chapter") != "未开始" else None, "position": progress.get("position")}})


@router.get("/dashboard/system-status")
def dashboard_system_status(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    health = run_system_health_checks(db, settings)
    checks = {item["name"]: item for item in health["checks"]}
    enabled = _rows(db, "SELECT * FROM `MonitorFolder` WHERE `enabled` = 1 ORDER BY `createdAt` DESC") if _has_table(db, "MonitorFolder") else []
    current_task = _row(db, "SELECT * FROM `ImportTask` WHERE `status` IN ('PENDING', 'PARSING') ORDER BY `createdAt` DESC LIMIT 1") if _has_table(db, "ImportTask") else None
    latest_task = _row(db, "SELECT * FROM `ImportTask` ORDER BY `createdAt` DESC LIMIT 1") if _has_table(db, "ImportTask") else None
    return ok(
        {
            "database": checks.get("database", {"status": "unknown", "message": "待检测"}),
            "worker": {"status": "ok", "message": "正在监听监控文件夹"} if enabled else {"status": "unknown", "message": "未启用监控文件夹"},
            "enabledMonitorFolders": enabled,
            "currentImportTask": current_task,
            "latestImportTask": latest_task,
            "errorFileCount": _table_count(db, "ImportTask", "`status` = 'FAILED'"),
            "monitorRootReadable": checks.get("monitorRootReadable", {"status": "unknown", "message": "待检测"}),
            "storageWritable": checks.get("storageWritable", {"status": "unknown", "message": "待检测"}),
        }
    )


@router.get("/management/overview")
def management_overview(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    health = run_system_health_checks(db, settings)
    event_storage = _prune_system_events(db)
    failed_imports = _table_count(db, "ImportTask", "`status` = 'FAILED'")
    failed_downloads = _table_count(db, "DownloadTask", "`status` = 'failed'")
    pending_organize = _table_count(db, "LibraryWork", "`hidden` = 0 AND `organizeStatus` IN ('PENDING', 'REVIEWING')")
    managed_files = _rows(db, "SELECT `path` FROM `LibraryFile`") if _has_table(db, "LibraryFile") else []
    file_paths = {str(item.get("path") or "") for item in managed_files if item.get("path")}
    orphan_count = 0
    library_root = settings.resolved_storage_root / "library"
    if library_root.exists():
        try:
            for path in library_root.rglob("*"):
                if path.is_file() and str(path) not in file_paths:
                    orphan_count += 1
                    if orphan_count > 1000:
                        break
        except OSError:
            orphan_count = 0
    checks = {item["name"]: item for item in health["checks"]}
    recent_events = _rows(db, "SELECT * FROM `SystemEvent` ORDER BY `createdAt` DESC LIMIT 8") if _has_table(db, "SystemEvent") else []
    storage = _scalar(db, "SELECT COALESCE(SUM(`sizeBytes`), 0) FROM `LibraryFile`", default=0) if _has_table(db, "LibraryFile") else 0
    return ok(
        {
            "cards": {
                "failedImports": failed_imports,
                "failedDownloads": failed_downloads,
                "orphanFiles": orphan_count,
                "pendingOrganize": pending_organize,
                "managedStorageBytes": int(storage or 0),
                "eventLogSizeBytes": event_storage["sizeBytes"],
                "eventLogMaxBytes": event_storage["maxBytes"],
            },
            "checks": {
                "database": checks.get("database", {"status": "unknown", "message": "待检测"}),
                "monitorRootReadable": checks.get("monitorRootReadable", {"status": "unknown", "message": "待检测"}),
                "storageWritable": checks.get("storageWritable", {"status": "unknown", "message": "待检测"}),
            },
            "recentEvents": [_serialize_system_event(event) for event in recent_events],
        }
    )


@router.get("/management/events")
def list_system_events(request: Request, page: int = 1, pageSize: int = 50, level: str | None = None, source: str | None = None, targetType: str | None = None, search: str | None = None, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    page = max(1, page)
    page_size = min(100, max(1, pageSize))
    if not _has_table(db, "SystemEvent"):
        return ok({"events": [], "page": page, "pageSize": page_size, "total": 0, "totalPages": 1, "storage": {"sizeBytes": 0, "maxBytes": 5 * 1024 * 1024}})
    storage = _prune_system_events(db)
    where: list[str] = []
    params: dict[str, Any] = {"limit": page_size, "offset": (page - 1) * page_size}
    if level:
        where.append("`level` = :level")
        params["level"] = "warning" if level == "warn" else level
    if source:
        where.append("`source` = :source")
        params["source"] = source
    if targetType:
        where.append("`targetType` = :target_type")
        params["target_type"] = targetType
    if search:
        where.append("(`message` LIKE :term OR `action` LIKE :term OR `targetId` LIKE :term)")
        params["term"] = f"%{search.strip()}%"
    where_sql = " AND ".join(where) if where else "1 = 1"
    total = _table_count(db, "SystemEvent", where_sql, params)
    events = _rows(db, f"SELECT * FROM `SystemEvent` WHERE {where_sql} ORDER BY `createdAt` DESC LIMIT :limit OFFSET :offset", params)
    sources = _rows(db, "SELECT `source`, COUNT(*) AS `count` FROM `SystemEvent` GROUP BY `source` ORDER BY `source` ASC")
    levels = _rows(db, "SELECT `level`, COUNT(*) AS `count` FROM `SystemEvent` GROUP BY `level` ORDER BY `level` ASC")
    return ok({"events": [_serialize_system_event(event) for event in events], "page": page, "pageSize": page_size, "total": total, "totalPages": max(1, (total + page_size - 1) // page_size), "storage": storage, "facets": {"sources": sources, "levels": levels}})


@router.delete("/management/events")
def clear_system_events(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    if not _has_table(db, "SystemEvent"):
        return ok({"deleted": 0})
    result = db.execute(text("DELETE FROM `SystemEvent` WHERE `level` IN ('info', 'warning')"))
    db.commit()
    deleted = result.rowcount or 0
    _record_system_event(db, level="info", source="system", action="events.cleared", actor_type="admin", actor_id=user.id, target_type="events", message=f"清理结构化日志 {deleted} 条", metadata={"deleted": deleted})
    return ok({"deleted": deleted, "storage": _prune_system_events(db)})


@router.get("/management/folders")
def management_folders(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    monitor_folders = _rows(db, "SELECT * FROM `MonitorFolder` ORDER BY `createdAt` DESC") if _has_table(db, "MonitorFolder") else []
    source_nodes = [{**folder, **_source_folder_preview(str(folder.get("rootPath") or ""))} for folder in monitor_folders]
    works = _rows(db, "SELECT `id`, `title`, `author`, `seriesName`, `workType`, `monitorFolderId`, `organizeStatus`, `hidden`, `updatedAt` FROM `LibraryWork` WHERE `hidden` = 0 ORDER BY `updatedAt` DESC LIMIT 300") if _has_table(db, "LibraryWork") else []
    editions = _rows(db, "SELECT `workId`, COALESCE(SUM(`sizeBytes`), 0) AS `sizeBytes`, COUNT(*) AS `editionCount` FROM `LibraryEdition` WHERE `hidden` = 0 GROUP BY `workId`") if _has_table(db, "LibraryEdition") else []
    size_by_work = {row.get("workId"): row for row in editions}
    work_items = [{**work, "sizeBytes": int((size_by_work.get(work.get("id")) or {}).get("sizeBytes") or 0), "editionCount": int((size_by_work.get(work.get("id")) or {}).get("editionCount") or 0)} for work in works]

    def grouped(key: str, fallback: str) -> list[dict[str, Any]]:
        buckets: dict[str, list[dict[str, Any]]] = {}
        for work in work_items:
            value = str(work.get(key) or fallback).strip() or fallback
            buckets.setdefault(value, []).append(work)
        return [{"name": name, "count": len(items), "sizeBytes": sum(int(item.get("sizeBytes") or 0) for item in items), "items": items[:20]} for name, items in sorted(buckets.items(), key=lambda item: item[0])]

    source_names = {folder.get("id"): folder.get("name") for folder in monitor_folders}
    by_source: dict[str, list[dict[str, Any]]] = {}
    for work in work_items:
        name = source_names.get(work.get("monitorFolderId")) or "手动导入"
        by_source.setdefault(str(name), []).append(work)
    file_rows = _rows(db, "SELECT `path`, `sizeBytes` FROM `LibraryFile` ORDER BY `path` ASC LIMIT 2000") if _has_table(db, "LibraryFile") else []
    managed_paths = []
    storage_root = settings.resolved_storage_root
    for file in file_rows:
        path_value = str(file.get("path") or "")
        try:
            resolved = Path(path_value).resolve()
            managed_paths.append(str(resolved.relative_to(storage_root.resolve())))
        except Exception:
            managed_paths.append(path_value)
    return ok(
        {
            "logical": {
                "series": grouped("seriesName", "未分系列"),
                "authors": grouped("author", "未知作者"),
                "formats": grouped("workType", "未知格式"),
                "sources": [{"name": name, "count": len(items), "sizeBytes": sum(int(item.get("sizeBytes") or 0) for item in items), "items": items[:20]} for name, items in sorted(by_source.items(), key=lambda item: item[0])],
            },
            "disk": {
                "sources": source_nodes,
                "managed": {"rootPath": str(storage_root / "library"), "tree": _path_tree(managed_paths, "library")},
            },
            "works": work_items,
        }
    )


@router.get("/series")
def list_series(request: Request, visibility: str = "active", limit: int = 50, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    if not _has_table(db, "LibraryWork") or not _has_column(db, "LibraryWork", "seriesName"):
        return ok({"series": [], "total": 0})

    take = min(100, max(1, limit))
    where = ["`seriesName` IS NOT NULL", "TRIM(`seriesName`) != ''"]
    params: dict[str, Any] = {"limit": take}
    if visibility == "ignored":
        where.append("`hidden` = 1")
    elif visibility != "all":
        where.append("`hidden` = 0")
    where_sql = " AND ".join(where)
    total = int(
        _scalar(
            db,
            f"SELECT COUNT(*) FROM (SELECT TRIM(`seriesName`) FROM `LibraryWork` WHERE {where_sql} GROUP BY TRIM(`seriesName`)) grouped_series",
            params,
            0,
        )
    )
    rows = _rows(
        db,
        f"""
        SELECT
            TRIM(`seriesName`) AS name,
            COUNT(*) AS bookCount,
            MAX(`updatedAt`) AS latestUpdatedAt
        FROM `LibraryWork`
        WHERE {where_sql}
        GROUP BY TRIM(`seriesName`)
        ORDER BY MAX(`updatedAt`) DESC, TRIM(`seriesName`) ASC
        LIMIT :limit
        """,
        params,
    )
    return ok({"series": [{"name": row.get("name"), "bookCount": row.get("bookCount") or 0, "latestUpdatedAt": _dt(row.get("latestUpdatedAt"))} for row in rows], "total": total})


@router.get("/works")
def list_works(request: Request, page: int = 1, pageSize: int = 24, visibility: str = "active", search: str | None = None, keyword: str | None = None, seriesName: str | None = None, sort: str = "updated", db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    if not _has_table(db, "LibraryWork"):
        return ok({"books": [], "page": page, "pageSize": pageSize, "total": 0, "totalPages": 1})
    page = max(1, page)
    page_size = min(60, max(1, pageSize))
    where = []
    params: dict[str, Any] = {"limit": page_size, "offset": (page - 1) * page_size}
    if visibility == "ignored":
        where.append("`hidden` = 1")
    elif visibility != "all":
        where.append("`hidden` = 0")
    term = (search or keyword or "").strip()
    if term:
        search_fields = ["`title` LIKE :term", "`author` LIKE :term", "`tags` LIKE :term"]
        if _has_column(db, "LibraryWork", "seriesName"):
            search_fields.append("`seriesName` LIKE :term")
        where.append(f"({' OR '.join(search_fields)})")
        params["term"] = f"%{term}%"
    series_name = (seriesName or "").strip()
    if series_name and _has_column(db, "LibraryWork", "seriesName"):
        where.append("TRIM(`seriesName`) = :series_name")
        params["series_name"] = series_name
    where_sql = " AND ".join(where) if where else "1 = 1"
    order = "CASE WHEN `seriesIndex` IS NULL THEN 1 ELSE 0 END ASC, `seriesIndex` ASC, `title` ASC" if sort == "series_index" and _has_column(db, "LibraryWork", "seriesIndex") else "`title` ASC" if sort == "title" else "`author` ASC" if sort == "author" else "`updatedAt` DESC"
    total = _table_count(db, "LibraryWork", where_sql, params)
    works = _rows(db, f"SELECT * FROM `LibraryWork` WHERE {where_sql} ORDER BY {order} LIMIT :limit OFFSET :offset", params)
    return ok({"books": [_work_view(db, work, user.id) for work in works], "page": page, "pageSize": page_size, "total": total, "totalPages": max(1, (total + page_size - 1) // page_size)})


@router.get("/works/{work_id}")
def get_work(work_id: str, request: Request, volumeId: str | None = None, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    work = _get_work(db, work_id)
    if not work:
        return fail("作品不存在", status_code=404)
    book = _work_view(db, work, user.id)
    return ok({"book": book, **_work_detail_navigation(db, book.get("recentEditionId") or book.get("editionId"), user.id, volumeId)})


@router.patch("/works/{work_id}")
async def update_work(work_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    allowed = {"title", "author", "description", "status", "publicationStatus", "trackingStatus", "tags", "seriesName", "seriesIndex", "publishedYear", "hidden", "organized", "metadataQuality"}
    values = {key: (_json_text(value) if key == "tags" and isinstance(value, list) else value) for key, value in payload.items() if key in allowed}
    if "ignored" in payload:
        values["hidden"] = bool(payload.get("ignored"))
    try:
        if "seriesIndex" in values:
            values["seriesIndex"] = _nullable_float(values["seriesIndex"], "系列序号")
        if "publishedYear" in values:
            values["publishedYear"] = _nullable_int(values["publishedYear"], "出版年")
    except ValueError as exc:
        return fail(str(exc), status_code=400)
    work = _update(db, "LibraryWork", work_id, values)
    if not work:
        return fail("作品不存在", status_code=404)
    return ok({"book": _work_view(db, work, _user.id)})


@router.delete("/works/{work_id}")
def delete_work(work_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    work = _get_work(db, work_id)
    result = _delete_work_and_storage(db, work_id, settings)
    if result.get("deleted"):
        _record_system_event(
            db,
            level="error",
            source="library",
            actor_type="admin",
            actor_id=user.id,
            action="deleted",
            target_type="work",
            target_id=work_id,
            message=f"彻底删除托管作品：{(work or {}).get('title') or work_id}",
            metadata={"workTitle": (work or {}).get("title"), "deletedFiles": result.get("deletedFiles"), "failedFileDeletes": result.get("failedFileDeletes")},
        )
    return ok(result)


@router.post("/works/bulk")
async def bulk_works(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    ids = payload.get("ids") or payload.get("bookIds") or []
    action = payload.get("action")
    updated = 0
    if action is None and "ignored" in payload:
        action = "ignore" if payload.get("ignored") else "restore"
    if action is None and payload.get("deleteRecords"):
        action = "delete_records"
    if _has_table(db, "LibraryWork") and ids and action in {"delete", "delete_records"}:
        deleted_files = 0
        failed_file_deletes: list[dict[str, str]] = []
        for work_id in ids:
            result = _delete_work_and_storage(db, str(work_id), settings)
            if result["deleted"]:
                updated += 1
                deleted_files += int(result.get("deletedFiles") or 0)
                failed_file_deletes.extend(result.get("failedFileDeletes") or [])
        if updated:
            _record_system_event(db, level="error", source="library", actor_type="admin", actor_id=user.id, action="bulk.deleted", target_type="work", message=f"批量彻底删除托管作品 {updated} 个", metadata={"ids": ids, "deletedFiles": deleted_files, "failedFileDeletes": failed_file_deletes})
        return ok({"updated": updated, "deleted": updated, "deletedFiles": deleted_files, "failedFileDeletes": failed_file_deletes, "ids": ids})
    if _has_table(db, "LibraryWork") and ids and action in {"hide", "ignore", "restore", "unignore", "mark_organized"}:
        hidden = action in {"hide", "ignore"}
        organized = action == "mark_organized"
        for work_id in ids:
            values = {"hidden": hidden} if action != "mark_organized" else {"organized": organized}
            if _update(db, "LibraryWork", str(work_id), values):
                updated += 1
        if updated:
            _record_system_event(db, level="info", source="library", actor_type="admin", actor_id=user.id, action=f"bulk.{action}", target_type="work", message=f"批量更新作品 {updated} 个", metadata={"ids": ids, "action": action})
    return ok({"updated": updated, "ids": ids})


@router.post("/works/import")
async def import_work(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    form = await request.form()
    files = [value for value in form.values() if hasattr(value, "filename")]
    if not files:
        return fail("请选择要导入的文件", status_code=400)

    import_dir = settings.resolved_storage_root / "imports" / str(time_ns())
    import_dir.mkdir(parents=True, exist_ok=True)
    tasks: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []

    for upload in files:
        file_name = _safe_upload_name(getattr(upload, "filename", None))
        target = import_dir / file_name
        with target.open("wb") as handle:
            shutil.copyfileobj(upload.file, handle)
        if not is_supported_import_file(target):
            target.unlink(missing_ok=True)
            return fail("当前版本仅支持 EPUB、CBZ、ZIP、PDF 格式。", status_code=400, details={"file": file_name})
        try:
            result = import_managed_book(
                db,
                settings,
                ImportOptions(
                    source_file_path=target,
                    original_name=file_name,
                    origin="MANUAL",
                    import_mode="MOVE",
                ),
            )
            task = _row(db, "SELECT * FROM `ImportTask` WHERE `sourcePath` = :source_path ORDER BY `createdAt` DESC LIMIT 1", {"source_path": str(target)}) if _has_table(db, "ImportTask") else None
            if task:
                tasks.append(task)
                _record_system_event(
                    db,
                    level="warning" if result.import_status == "FAILED" else "info",
                    source="import",
                    actor_type="admin",
                    actor_id=user.id,
                    action="imported" if result.import_status != "FAILED" else "failed",
                    target_type="importTask",
                    target_id=task.get("id"),
                    message=f"手动导入：{result.title}",
                    metadata={"file": file_name, "workId": result.work_id, "editionId": result.edition_id, "duplicate": result.duplicate},
                )
            results.append(
                {
                    "bookId": result.book_id,
                    "workId": result.work_id,
                    "editionId": result.edition_id,
                    "volumeId": result.volume_id,
                    "title": result.title,
                    "type": result.type,
                    "format": result.format,
                    "totalUnits": result.total_units,
                    "importStatus": result.import_status,
                    "duplicate": result.duplicate,
                    "merged": result.merged,
                    "mergeReason": result.merge_reason,
                }
            )
        except Exception as exc:
            failed_task = _row(db, "SELECT * FROM `ImportTask` WHERE `sourcePath` = :source_path ORDER BY `createdAt` DESC LIMIT 1", {"source_path": str(target)}) if _has_table(db, "ImportTask") else None
            if failed_task:
                tasks.append(failed_task)
            _record_system_event(db, level="error", source="import", actor_type="admin", actor_id=user.id, action="failed", target_type="importTask", target_id=(failed_task or {}).get("id"), message=f"手动导入失败：{file_name}", metadata={"file": file_name, "error": str(exc)})
            return fail("导入失败", status_code=400, details={"file": file_name, "message": str(exc), "tasks": tasks})

    return ok({"tasks": tasks, "results": results, "queued": len(files), "imported": len(results)})


@router.get("/monitor-folders")
def list_monitor_folders(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    folders = _rows(db, "SELECT * FROM `MonitorFolder` ORDER BY `createdAt` DESC") if _has_table(db, "MonitorFolder") else []
    return ok({"folders": folders})


@router.post("/monitor-folders")
async def create_monitor_folder(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    root_path = _normalize_monitor_root_path(payload.get("rootPath"))
    if not root_path:
        return fail("请填写监控文件夹路径", status_code=400)
    if _monitor_folder_by_root_path(db, root_path):
        return fail("监控文件夹路径已存在", status_code=409, details={"rootPath": root_path})
    import_mode = str(payload.get("importMode") or "COPY").upper()
    move_error = _monitor_move_writable_error(root_path, import_mode)
    if move_error:
        return move_error
    try:
        folder = _insert(
            db,
            "MonitorFolder",
            {
                "id": f"py_{time_ns()}",
                "name": payload.get("name") or Path(root_path).name or "监控文件夹",
                "rootPath": root_path,
                "enabled": bool(payload.get("enabled", True)),
                "importMode": import_mode,
                "ignorePatterns": payload.get("ignorePatterns"),
                "ignoreHidden": bool(payload.get("ignoreHidden", True)),
                "minFileSizeBytes": int(payload.get("minFileSizeBytes") or 10240),
                "description": payload.get("description"),
                "createdAt": _now(),
                "updatedAt": _now(),
            },
        )
    except IntegrityError:
        db.rollback()
        return fail("监控文件夹路径已存在", status_code=409, details={"rootPath": root_path})
    _record_system_event(db, level="info", source="folder", actor_type="admin", actor_id=user.id, action="created", target_type="monitorFolder", target_id=folder.get("id"), message=f"新增来源目录：{folder.get('name')}", metadata={"rootPath": root_path, "importMode": import_mode})
    return ok({"folder": folder}, status_code=201)


@router.put("/monitor-folders/{folder_id}")
@router.patch("/monitor-folders/{folder_id}")
async def update_monitor_folder(folder_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    mapping = {"rootPath": "rootPath", "importMode": "importMode", "minFileSizeBytes": "minFileSizeBytes", "ignorePatterns": "ignorePatterns", "ignoreHidden": "ignoreHidden", "enabled": "enabled", "name": "name", "description": "description"}
    values = {mapping[key]: value for key, value in payload.items() if key in mapping}
    existing = _row(db, "SELECT * FROM `MonitorFolder` WHERE `id` = :id", {"id": folder_id}) if _has_table(db, "MonitorFolder") else None
    if not existing:
        return fail("监控文件夹不存在", status_code=404)
    if "rootPath" in values:
        root_path = _normalize_monitor_root_path(values["rootPath"])
        if not root_path:
            return fail("请填写监控文件夹路径", status_code=400)
        if _monitor_folder_by_root_path(db, root_path, exclude_id=folder_id):
            return fail("监控文件夹路径已存在", status_code=409, details={"rootPath": root_path})
        values["rootPath"] = root_path
    if "importMode" in values:
        values["importMode"] = str(values["importMode"] or "COPY").upper()
    next_root_path = str(values.get("rootPath") or existing.get("rootPath") or "")
    next_import_mode = str(values.get("importMode") or existing.get("importMode") or "COPY").upper()
    move_error = _monitor_move_writable_error(next_root_path, next_import_mode)
    if move_error:
        return move_error
    if values:
        values["updatedAt"] = _now()
    try:
        folder = _update(db, "MonitorFolder", folder_id, values)
    except IntegrityError:
        db.rollback()
        return fail("监控文件夹路径已存在", status_code=409, details={"rootPath": values.get("rootPath")})
    if values:
        _record_system_event(db, level="info", source="folder", actor_type="admin", actor_id=user.id, action="updated", target_type="monitorFolder", target_id=folder_id, message=f"更新来源目录：{(folder or existing).get('name')}", metadata={"changes": values, "rootPath": (folder or existing).get("rootPath")})
    return ok({"folder": folder})


@router.delete("/monitor-folders/{folder_id}")
def delete_monitor_folder(folder_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    existing = _row(db, "SELECT * FROM `MonitorFolder` WHERE `id` = :id", {"id": folder_id}) if _has_table(db, "MonitorFolder") else None
    deleted = _delete(db, "MonitorFolder", folder_id)
    if deleted:
        _record_system_event(db, level="warning", source="folder", actor_type="admin", actor_id=user.id, action="deleted", target_type="monitorFolder", target_id=folder_id, message=f"删除来源目录：{(existing or {}).get('name') or folder_id}", metadata={"rootPath": (existing or {}).get("rootPath")})
    return ok({"deleted": deleted, "id": folder_id})


@router.get("/system-settings")
def get_system_settings(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    rows = _rows(db, "SELECT `key`, `value` FROM `SystemSetting`") if _has_table(db, "SystemSetting") else []
    return ok({"settings": {row["key"]: _parse_json(row.get("value"), row.get("value")) for row in rows}})


@router.put("/system-settings")
@router.patch("/system-settings")
async def update_system_settings(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    values = payload.get("settings", payload)
    if not isinstance(values, dict):
        return fail("设置格式不正确", status_code=400)
    saved = {}
    if not _has_table(db, "SystemSetting"):
        return ok({"settings": values})
    keys = [str(key) for key in values.keys()]
    existing: set[str] = set()
    if keys:
        placeholders = ", ".join(f":key_{index}" for index, _ in enumerate(keys))
        params = {f"key_{index}": key for index, key in enumerate(keys)}
        existing = {row["key"] for row in _rows(db, f"SELECT `key` FROM `SystemSetting` WHERE `key` IN ({placeholders})", params)}
    now = _now()
    for raw_key, value in values.items():
        key = str(raw_key)
        serialized = _json_text(value)
        if key in existing:
            db.execute(text("UPDATE `SystemSetting` SET `value` = :value, `updatedAt` = :updated_at WHERE `key` = :key"), {"key": key, "value": serialized, "updated_at": now})
        else:
            db.execute(
                text("INSERT INTO `SystemSetting` (`key`, `value`, `createdAt`, `updatedAt`) VALUES (:key, :value, :created_at, :updated_at)"),
                {"key": key, "value": serialized, "created_at": now, "updated_at": now},
            )
        saved[key] = value
    db.commit()
    _record_system_event(db, level="warning", source="system", actor_type="admin", actor_id=user.id, action="settings.updated", target_type="settings", message=f"更新系统设置 {len(saved)} 项", metadata={"keys": list(saved.keys())})
    return ok({"settings": saved})


@router.get("/reader/preferences")
def list_reader_preferences(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    rows = _rows(db, "SELECT * FROM `ReaderPreference` WHERE `userId` = :user_id", {"user_id": user.id}) if _has_table(db, "ReaderPreference") else []
    return ok({"preferences": {row["readerType"]: _parse_json(row.get("settings"), {}) for row in rows}})


@router.put("/reader/preferences")
async def save_reader_preferences(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    preferences = payload.get("preferences", payload)
    if isinstance(preferences, dict):
        for reader_type, reader_settings in preferences.items():
            existing = _row(db, "SELECT * FROM `ReaderPreference` WHERE `userId` = :user_id AND `readerType` = :reader_type", {"user_id": user.id, "reader_type": reader_type}) if _has_table(db, "ReaderPreference") else None
            if existing:
                _update(db, "ReaderPreference", existing["id"], {"settings": _json_text(reader_settings), "updatedAt": _now()})
            elif _has_table(db, "ReaderPreference"):
                _insert(db, "ReaderPreference", {"id": f"py_{time_ns()}", "userId": user.id, "readerType": reader_type, "settings": _json_text(reader_settings), "createdAt": _now(), "updatedAt": _now()})
    return ok({"preferences": preferences})


@router.get("/reader/preferences/{reader_type}")
def get_reader_preference(reader_type: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    row = _row(db, "SELECT * FROM `ReaderPreference` WHERE `userId` = :user_id AND `readerType` = :reader_type", {"user_id": user.id, "reader_type": reader_type}) if _has_table(db, "ReaderPreference") else None
    return ok({"readerType": reader_type, "settings": _parse_json((row or {}).get("settings"), {})})


@router.put("/reader/preferences/{reader_type}")
@router.patch("/reader/preferences/{reader_type}")
async def save_reader_preference(reader_type: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    prefs = payload.get("settings", payload)
    existing = _row(db, "SELECT * FROM `ReaderPreference` WHERE `userId` = :user_id AND `readerType` = :reader_type", {"user_id": user.id, "reader_type": reader_type}) if _has_table(db, "ReaderPreference") else None
    if existing:
        _update(db, "ReaderPreference", existing["id"], {"settings": _json_text(prefs), "updatedAt": _now()})
    elif _has_table(db, "ReaderPreference"):
        _insert(db, "ReaderPreference", {"id": f"py_{time_ns()}", "userId": user.id, "readerType": reader_type, "settings": _json_text(prefs), "createdAt": _now(), "updatedAt": _now()})
    return ok({"readerType": reader_type, "settings": prefs})


@router.get("/reader/{edition_id}/bootstrap")
def reader_bootstrap(edition_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    edition = _row(db, "SELECT * FROM `LibraryEdition` WHERE `id` = :id", {"id": edition_id}) if _has_table(db, "LibraryEdition") else None
    if not edition:
        return fail("版本不存在", status_code=404)
    work = _get_work(db, edition["workId"])
    units = _rows(db, "SELECT * FROM `LibraryReadingUnit` WHERE `editionId` = :edition_id ORDER BY `sortOrder` ASC", {"edition_id": edition_id}) if _has_table(db, "LibraryReadingUnit") else []
    progress_rows = _rows(db, "SELECT * FROM `LibraryReadingProgress` WHERE `userId` = :user_id AND `editionId` = :edition_id ORDER BY `updatedAt` DESC", {"user_id": user.id, "edition_id": edition_id}) if _has_table(db, "LibraryReadingProgress") else []
    preferences = {
        row["readerType"]: _parse_json(row.get("settings"), {})
        for row in (_rows(db, "SELECT * FROM `ReaderPreference` WHERE `userId` = :user_id", {"user_id": user.id}) if _has_table(db, "ReaderPreference") else [])
    }
    work_view = _work_view(db, work, user.id) if work else None
    book_view = {**work_view, "editionId": edition["id"], "formatValue": edition.get("format")} if work_view else None
    reader_type = "comic" if edition.get("format") == "COMIC" else ("ebook" if edition.get("format") == "EPUB" else ("pdf" if edition.get("format") == "PDF" else "unknown"))
    def base_payload(progress: dict[str, Any] | None) -> dict[str, Any]:
        return {"book": book_view, "edition": edition, "units": units, "progress": progress, "preferences": preferences, "readerType": reader_type}
    if reader_type == "pdf":
        progress = _latest_progress(progress_rows)
        volumes = _rows(db, "SELECT * FROM `LibraryVolume` WHERE `editionId` = :edition_id ORDER BY `sortOrder` ASC", {"edition_id": edition_id}) if _has_table(db, "LibraryVolume") else []
        volume = volumes[0] if volumes else None
        page_count = int(volume.get("pageCount") or edition.get("pageCount") or 1) if volume else int(edition.get("pageCount") or 1)
        return ok(
            {
                **base_payload(progress),
                "volumeSection": _volume_section_view(volume, "PDF", page_count, progress) if volume else None,
                "volumeSections": [_volume_section_view(item, "PDF", progress=_progress_for_volume(progress_rows, item["id"])) for item in volumes],
                "pageCount": page_count,
                "pages": [{"pageIndex": index + 1, "title": f"第 {index + 1} 页"} for index in range(page_count)],
                "totalUnits": page_count,
            }
        )
    if reader_type == "ebook":
        requested_volume_id = request.query_params.get("volume")
        volumes = _rows(db, "SELECT * FROM `LibraryVolume` WHERE `editionId` = :edition_id ORDER BY `sortOrder` ASC", {"edition_id": edition_id}) if _has_table(db, "LibraryVolume") else []
        volume = next((item for item in volumes if item["id"] == requested_volume_id), None) if requested_volume_id else None
        volume = volume or _choose_continue_volume(volumes, progress_rows) or (volumes[0] if volumes else None)
        progress = (_progress_for_volume(progress_rows, volume["id"]) or _empty_progress_for_volume(edition, volume)) if volume else _latest_progress(progress_rows)
        scoped_units = [unit for unit in units if not volume or unit.get("volumeId") == volume["id"]]
        reading_units = [_reading_unit_view(unit) for unit in scoped_units]
        return ok(
            {
                **base_payload(progress),
                "volumeSection": _volume_section_view(volume, "EPUB", len(scoped_units), progress) if volume else None,
                "volumeSections": [_volume_section_view(item, "EPUB", progress=_progress_for_volume(progress_rows, item["id"])) for item in volumes],
                "readingUnits": reading_units,
                "totalUnits": len(reading_units),
            }
        )
    if reader_type == "comic":
        requested_volume_id = request.query_params.get("volume")
        volumes = _rows(db, "SELECT * FROM `LibraryVolume` WHERE `editionId` = :edition_id ORDER BY `sortOrder` ASC", {"edition_id": edition_id}) if _has_table(db, "LibraryVolume") else []
        volume = next((item for item in volumes if item["id"] == requested_volume_id), None) if requested_volume_id else None
        volume = volume or _choose_continue_volume(volumes, progress_rows) or (volumes[0] if volumes else None)
        progress = (_progress_for_volume(progress_rows, volume["id"]) or _empty_progress_for_volume(edition, volume)) if volume else _latest_progress(progress_rows)
        page_units = [unit for unit in units if not volume or unit.get("volumeId") == volume["id"]]
        if volume and not page_units:
            _ensure_volume_page_index(db, settings, volume["id"])
            page_units = _rows(db, "SELECT * FROM `LibraryReadingUnit` WHERE `volumeId` = :volume_id AND LOWER(`unitType`) = 'page' ORDER BY `sortOrder` ASC", {"volume_id": volume["id"]}) if _has_table(db, "LibraryReadingUnit") else []
        pages = [
            {
                "pageIndex": index + 1,
                "title": page.get("title"),
                "mimeType": page.get("mediaType"),
                "width": page.get("width"),
                "height": page.get("height"),
                "size": page.get("size"),
            }
            for index, page in enumerate(page_units)
        ]
        return ok(
            {
                **base_payload(progress),
                "volumeSection": _volume_section_view(volume, "COMIC", len(page_units), progress) if volume else None,
                "volumeSections": [_volume_section_view(item, "COMIC", progress=_progress_for_volume(progress_rows, item["id"])) for item in volumes],
                "pageCount": len(page_units),
                "pages": pages,
            }
        )
    return ok(base_payload(_latest_progress(progress_rows)))


def _reading_unit_view(unit: dict[str, Any]) -> dict[str, Any]:
    return {**unit, "metadataJson": _parse_json(unit.get("metadataJson"), {})}


def _volume_section_view(volume: dict[str, Any], fmt: str, count_override: int | None = None, progress: dict[str, Any] | None = None) -> dict[str, Any]:
    count_key = "pageCount" if fmt in {"COMIC", "PDF"} else "chapterCount"
    return {
        "id": volume["id"],
        "title": volume.get("title") or "未命名卷",
        "index": volume.get("volumeIndex") or volume.get("sortOrder") or 0,
        "fileId": volume.get("fileId") or volume["id"],
        "pageCount": count_override if count_override is not None else (volume.get(count_key) or 0),
        "coverUrl": _cover_url("volumes", volume["id"], volume, editionId=volume.get("editionId")),
        "progress": _raw_progress_percent(progress),
        "lastReadAt": _dt(progress.get("updatedAt")) if progress else None,
        "position": progress.get("position") if progress else None,
        "currentPage": progress.get("page") if progress else None,
    }


def _work_detail_navigation(db: Session, edition_id: str | None, user_id: str | None = None, requested_volume_id: str | None = None) -> dict[str, Any]:
    if not edition_id or not _has_table(db, "LibraryEdition"):
        return {"readingUnits": [], "volumeSections": []}
    edition = _row(db, "SELECT * FROM `LibraryEdition` WHERE `id` = :id", {"id": edition_id})
    if not edition:
        return {"readingUnits": [], "volumeSections": []}
    progresses = _rows(db, "SELECT * FROM `LibraryReadingProgress` WHERE `editionId` = :edition_id AND `userId` = :user_id ORDER BY `updatedAt` DESC", {"edition_id": edition_id, "user_id": user_id}) if user_id and _has_table(db, "LibraryReadingProgress") else []
    if edition.get("format") == "COMIC":
        volumes = _rows(db, "SELECT * FROM `LibraryVolume` WHERE `editionId` = :edition_id ORDER BY `sortOrder` ASC", {"edition_id": edition_id}) if _has_table(db, "LibraryVolume") else []
        return {
            "readingUnits": [],
            "volumeSections": [_volume_section_view(volume, "COMIC", progress=_progress_for_volume(progresses, volume["id"])) for volume in volumes],
        }
    if edition.get("format") == "PDF":
        volumes = _rows(db, "SELECT * FROM `LibraryVolume` WHERE `editionId` = :edition_id ORDER BY `sortOrder` ASC", {"edition_id": edition_id}) if _has_table(db, "LibraryVolume") else []
        return {
            "readingUnits": [],
            "volumeSections": [_volume_section_view(volume, "PDF", progress=_progress_for_volume(progresses, volume["id"])) for volume in volumes],
        }
    volumes = _rows(db, "SELECT * FROM `LibraryVolume` WHERE `editionId` = :edition_id ORDER BY `sortOrder` ASC", {"edition_id": edition_id}) if _has_table(db, "LibraryVolume") else []
    if len(volumes) > 1:
        selected_volume = next((item for item in volumes if item["id"] == requested_volume_id), None) if requested_volume_id else None
        selected_volume = selected_volume or _choose_continue_volume(volumes, progresses) or volumes[0]
        units = _rows(db, "SELECT * FROM `LibraryReadingUnit` WHERE `editionId` = :edition_id AND `volumeId` = :volume_id ORDER BY `sortOrder` ASC", {"edition_id": edition_id, "volume_id": selected_volume["id"]}) if _has_table(db, "LibraryReadingUnit") else []
        return {
            "readingUnits": [_reading_unit_view(unit) for unit in units],
            "volumeSections": [_volume_section_view(volume, "EPUB", progress=_progress_for_volume(progresses, volume["id"])) for volume in volumes],
        }
    units = _rows(db, "SELECT * FROM `LibraryReadingUnit` WHERE `editionId` = :edition_id ORDER BY `sortOrder` ASC", {"edition_id": edition_id}) if _has_table(db, "LibraryReadingUnit") else []
    return {"readingUnits": [_reading_unit_view(unit) for unit in units], "volumeSections": []}


@router.get("/editions/{edition_id}/progress")
def get_progress(edition_id: str, request: Request, volumeId: str | None = None, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    if not _has_table(db, "LibraryReadingProgress"):
        progress = None
    elif volumeId:
        progress = _row(db, "SELECT * FROM `LibraryReadingProgress` WHERE `userId` = :user_id AND `editionId` = :edition_id AND `volumeId` = :volume_id ORDER BY `updatedAt` DESC LIMIT 1", {"user_id": user.id, "edition_id": edition_id, "volume_id": volumeId})
    else:
        progress = _row(db, "SELECT * FROM `LibraryReadingProgress` WHERE `userId` = :user_id AND `editionId` = :edition_id ORDER BY `updatedAt` DESC LIMIT 1", {"user_id": user.id, "edition_id": edition_id})
    return ok({"progress": progress})


@router.post("/editions/{edition_id}/progress")
@router.put("/editions/{edition_id}/progress")
@router.patch("/editions/{edition_id}/progress")
async def save_progress(edition_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    edition = _row(db, "SELECT * FROM `LibraryEdition` WHERE `id` = :id", {"id": edition_id}) if _has_table(db, "LibraryEdition") else None
    if not edition:
        return fail("版本不存在", status_code=404)
    volume_id = payload.get("volumeId")
    if volume_id and _has_table(db, "LibraryReadingProgress"):
        existing = _row(db, "SELECT * FROM `LibraryReadingProgress` WHERE `userId` = :user_id AND `editionId` = :edition_id AND `volumeId` = :volume_id", {"user_id": user.id, "edition_id": edition_id, "volume_id": volume_id})
    elif _has_table(db, "LibraryReadingProgress"):
        existing = _row(db, "SELECT * FROM `LibraryReadingProgress` WHERE `userId` = :user_id AND `editionId` = :edition_id AND `volumeId` IS NULL", {"user_id": user.id, "edition_id": edition_id})
    else:
        existing = None
    values = {"position": str(payload.get("position", "0")), "page": payload.get("page"), "percent": float(payload.get("percent", 0)), "extra": _json_text(payload.get("extra", {})), "volumeId": volume_id, "updatedAt": _now()}
    if existing:
        progress = _update(db, "LibraryReadingProgress", existing["id"], values)
    elif _has_table(db, "LibraryReadingProgress"):
        values.update({"id": f"py_{time_ns()}", "userId": user.id, "workId": edition["workId"], "editionId": edition_id, "volumeId": volume_id, "readerType": payload.get("readerType") or ("comic" if edition.get("format") == "COMIC" else ("pdf" if edition.get("format") == "PDF" else "epub")), "createdAt": _now()})
        progress = _insert(db, "LibraryReadingProgress", values)
    else:
        progress = values
    return ok({"progress": progress})


def _stored_path(path_value: str | None, settings: Settings) -> Path | None:
    if not path_value:
        return None
    path = Path(path_value)
    if not path.is_absolute():
        path = settings.resolved_storage_root / path
    try:
        resolved = path.expanduser().resolve()
        storage = settings.resolved_storage_root.resolve()
        if resolved == storage or storage in resolved.parents:
            return resolved
        monitor = settings.resolved_monitor_root
        if monitor:
            monitor = monitor.resolve()
            if resolved == monitor or monitor in resolved.parents:
                return resolved
    except OSError:
        return None
    return None


def _parse_byte_range(header: str | None, size: int) -> tuple[str, tuple[int, int] | None]:
    if not header:
        return "none", None
    match = re.match(r"^bytes=(\d*)-(\d*)$", header.strip())
    if not match:
        return "invalid", None
    raw_start, raw_end = match.groups()
    if not raw_start and not raw_end:
        return "invalid", None
    if size <= 0:
        return "unsatisfiable", None
    if not raw_start:
        try:
            suffix_length = int(raw_end)
        except ValueError:
            return "unsatisfiable", None
        if suffix_length <= 0:
            return "unsatisfiable", None
        return "range", (max(0, size - suffix_length), size - 1)
    try:
        start = int(raw_start)
        end = int(raw_end) if raw_end else size - 1
    except ValueError:
        return "unsatisfiable", None
    if start < 0 or end < start or start >= size:
        return "unsatisfiable", None
    return "range", (start, min(end, size - 1))


def _weak_etag(size: int, mtime_ms: int, extra: str = "") -> str:
    suffix = f"-{extra.encode('utf-8').hex()}" if extra else ""
    return f'W/"{size:x}-{mtime_ms:x}{suffix}"'


def _not_modified(request: Request, etag: str, last_modified: str) -> bool:
    if_none_match = request.headers.get("if-none-match")
    if if_none_match:
        tags = [tag.strip() for tag in if_none_match.split(",")]
        return "*" in tags or etag in tags
    if_modified_since = request.headers.get("if-modified-since")
    if if_modified_since:
        try:
            since = parsedate_to_datetime(if_modified_since)
            modified = parsedate_to_datetime(last_modified)
            return modified <= since
        except (TypeError, ValueError):
            return False
    return False


def _should_use_range(request: Request, etag: str, last_modified: str) -> bool:
    if_range = request.headers.get("if-range")
    if not if_range:
        return True
    if if_range.startswith("W/") or if_range.startswith('"'):
        return if_range == etag
    try:
        if_range_date = parsedate_to_datetime(if_range)
        modified = parsedate_to_datetime(last_modified)
        return modified <= if_range_date
    except (TypeError, ValueError):
        return False


def _response_headers(size: int, mtime: float, media_type: str, name: str, extra: str = "") -> dict[str, str]:
    modified = datetime.fromtimestamp(mtime, timezone.utc).replace(microsecond=0)
    return {
        "Accept-Ranges": "bytes",
        "Content-Type": media_type,
        "Content-Disposition": f"inline; filename*=UTF-8''{quote(name)}",
        "Cache-Control": "private, max-age=86400" if media_type.lower().startswith("image/") else "private, max-age=60",
        "ETag": _weak_etag(size, int(mtime * 1000), extra),
        "Last-Modified": format_datetime(modified, usegmt=True),
    }


def _bytes_response(data: bytes, request: Request, media_type: str, name: str, mtime: float | None = None, extra: str = "") -> Response:
    started_at = monotonic()
    size = len(data)
    headers = _response_headers(size, mtime or _now().timestamp(), media_type, name, extra)
    if not request.headers.get("range") and _not_modified(request, headers["ETag"], headers["Last-Modified"]):
        return Response(status_code=304, headers=headers)
    range_header = request.headers.get("range")
    byte_range = None
    if range_header and _should_use_range(request, headers["ETag"], headers["Last-Modified"]):
        kind, parsed = _parse_byte_range(range_header, size)
        if kind == "invalid":
            response = fail("Range 请求格式不正确", status_code=416)
            response.headers["Content-Range"] = f"bytes */{size}"
            return response
        if kind == "unsatisfiable":
            response = fail("Range 超出文件大小", status_code=416)
            response.headers["Content-Range"] = f"bytes */{size}"
            return response
        byte_range = parsed
    if byte_range:
        start, end = byte_range
        body = data[start : end + 1]
        headers["Content-Length"] = str(len(body))
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        _log_slow_file_request(request, "bytes", "memory", request.headers.get("range"), len(body), 206, started_at)
        return Response(content=body, status_code=206, headers=headers, media_type=media_type)
    headers["Content-Length"] = str(size)
    _log_slow_file_request(request, "bytes", "memory", request.headers.get("range"), size, 200, started_at)
    return Response(content=data, headers=headers, media_type=media_type)


def _file_stream_limit_response() -> Response:
    return fail("同时文件流请求过多，请稍后重试", status_code=429)


def _acquire_file_stream_slot(user_id: str):
    limit = STREAMS_PER_USER_LIMIT
    with _active_file_streams_lock:
        current = _active_file_streams_by_user.get(user_id, 0)
        if current >= limit:
            return None
        _active_file_streams_by_user[user_id] = current + 1

    released = False

    def release() -> None:
        nonlocal released
        if released:
            return
        released = True
        with _active_file_streams_lock:
            next_count = max(0, _active_file_streams_by_user.get(user_id, 1) - 1)
            if next_count == 0:
                _active_file_streams_by_user.pop(user_id, None)
            else:
                _active_file_streams_by_user[user_id] = next_count

    return release


def _log_slow_file_request(request: Request, route: str, file_id: str, range_header: str | None, bytes_sent: int, status_code: int, started_at: float) -> None:
    threshold_ms = SLOW_REQUEST_LOG_THRESHOLD_MS
    duration_ms = int((monotonic() - started_at) * 1000)
    if duration_ms < threshold_ms:
        return
    logger.warning(
        "[slow-file-request] route=%s userId=%s fileId=%s range=%s bytes=%s status=%s durationMs=%s",
        route,
        getattr(request.state, "user_id", "unknown"),
        file_id,
        range_header,
        bytes_sent,
        status_code,
        duration_ms,
    )


def _file_response(path: Path | None, request: Request, user_id: str, media_type: str | None = None, name: str | None = None, missing_message: str = "文件不存在", route: str = "file", file_id: str | None = None) -> Response:
    if path is None or not path.exists() or not path.is_file():
        return fail(missing_message, status_code=404)
    request.state.user_id = user_id
    stat = path.stat()
    resolved_media_type = media_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    headers = _response_headers(stat.st_size, stat.st_mtime, resolved_media_type, name or path.name)
    if not request.headers.get("range") and _not_modified(request, headers["ETag"], headers["Last-Modified"]):
        return Response(status_code=304, headers=headers)
    byte_range = None
    range_header = request.headers.get("range")
    if range_header and _should_use_range(request, headers["ETag"], headers["Last-Modified"]):
        kind, parsed = _parse_byte_range(range_header, stat.st_size)
        if kind == "invalid":
            response = fail("Range 请求格式不正确", status_code=416)
            response.headers["Content-Range"] = f"bytes */{stat.st_size}"
            return response
        if kind == "unsatisfiable":
            response = fail("Range 超出文件大小", status_code=416)
            response.headers["Content-Range"] = f"bytes */{stat.st_size}"
            return response
        byte_range = parsed

    def iterator(release, started_at: float, status_code: int, bytes_sent: int, start: int = 0, end: int | None = None):
        try:
            remaining = None if end is None else end - start + 1
            with path.open("rb") as handle:
                handle.seek(start)
                while True:
                    chunk_size = 1024 * 1024 if remaining is None else min(1024 * 1024, remaining)
                    if chunk_size <= 0:
                        break
                    chunk = handle.read(chunk_size)
                    if not chunk:
                        break
                    if remaining is not None:
                        remaining -= len(chunk)
                    yield chunk
        finally:
            release()
            _log_slow_file_request(request, route, file_id or str(path), range_header, bytes_sent, status_code, started_at)

    release = _acquire_file_stream_slot(user_id)
    if release is None:
        return _file_stream_limit_response()
    started_at = monotonic()
    if byte_range:
        start, end = byte_range
        bytes_sent = end - start + 1
        headers["Content-Length"] = str(bytes_sent)
        headers["Content-Range"] = f"bytes {start}-{end}/{stat.st_size}"
        return StreamingResponse(iterator(release, started_at, 206, bytes_sent, start, end), status_code=206, headers=headers, media_type=resolved_media_type)
    headers["Content-Length"] = str(stat.st_size)
    return StreamingResponse(iterator(release, started_at, 200, stat.st_size), headers=headers, media_type=resolved_media_type)


def _send_file(path: Path | None, request: Request, user_id: str, media_type: str | None = None, name: str | None = None, route: str = "file", file_id: str | None = None) -> Response:
    return _file_response(path, request, user_id=user_id, media_type=media_type, name=name, route=route, file_id=file_id)


def _send_zip_entry(archive_path: Path | None, entry_name: str | None, request: Request, user_id: str, media_type: str | None = None, route: str = "zip-entry", file_id: str | None = None) -> Response:
    if archive_path is None or not archive_path.exists() or not archive_path.is_file() or not entry_name:
        return fail("页面不存在", status_code=404)
    try:
        with zipfile.ZipFile(archive_path) as archive:
            info = archive.getinfo(entry_name)
    except (KeyError, OSError, zipfile.BadZipFile):
        return fail("页面不存在", status_code=404)
    request.state.user_id = user_id
    resolved_media_type = media_type or mimetypes.guess_type(entry_name)[0] or "application/octet-stream"
    size = int(info.file_size)
    headers = _response_headers(size, archive_path.stat().st_mtime, resolved_media_type, Path(entry_name).name, extra=entry_name)
    if not request.headers.get("range") and _not_modified(request, headers["ETag"], headers["Last-Modified"]):
        return Response(status_code=304, headers=headers)
    byte_range = None
    range_header = request.headers.get("range")
    if range_header and _should_use_range(request, headers["ETag"], headers["Last-Modified"]):
        kind, parsed = _parse_byte_range(range_header, size)
        if kind == "invalid":
            response = fail("Range 请求格式不正确", status_code=416)
            response.headers["Content-Range"] = f"bytes */{size}"
            return response
        if kind == "unsatisfiable":
            response = fail("Range 超出文件大小", status_code=416)
            response.headers["Content-Range"] = f"bytes */{size}"
            return response
        byte_range = parsed

    def iterator(release, started_at: float, status_code: int, bytes_sent: int, start: int = 0, end: int | None = None):
        try:
            with zipfile.ZipFile(archive_path) as archive:
                with archive.open(entry_name, "r") as handle:
                    remaining_skip = start
                    while remaining_skip > 0:
                        skipped = handle.read(min(1024 * 1024, remaining_skip))
                        if not skipped:
                            return
                        remaining_skip -= len(skipped)
                    remaining = None if end is None else end - start + 1
                    while True:
                        chunk_size = 1024 * 1024 if remaining is None else min(1024 * 1024, remaining)
                        if chunk_size <= 0:
                            break
                        chunk = handle.read(chunk_size)
                        if not chunk:
                            break
                        if remaining is not None:
                            remaining -= len(chunk)
                        yield chunk
        finally:
            release()
            _log_slow_file_request(request, route, file_id or entry_name, range_header, bytes_sent, status_code, started_at)

    release = _acquire_file_stream_slot(user_id)
    if release is None:
        return _file_stream_limit_response()
    started_at = monotonic()
    if byte_range:
        start, end = byte_range
        bytes_sent = end - start + 1
        headers["Content-Length"] = str(bytes_sent)
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        return StreamingResponse(iterator(release, started_at, 206, bytes_sent, start, end), status_code=206, headers=headers, media_type=resolved_media_type)
    headers["Content-Length"] = str(size)
    return StreamingResponse(iterator(release, started_at, 200, size), headers=headers, media_type=resolved_media_type)


@router.get("/files/{file_id}")
def get_file(file_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    file = _row(db, "SELECT * FROM `LibraryFile` WHERE `id` = :id", {"id": file_id}) if _has_table(db, "LibraryFile") else None
    return _send_file(_stored_path((file or {}).get("path"), settings), request, user.id, media_type=(file or {}).get("mimeType"), name=Path((file or {}).get("path") or "file").name, route="files", file_id=file_id)


@router.get("/editions/{edition_id}/file")
def get_edition_file(edition_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    volume_id = request.query_params.get("volume")
    if volume_id and _has_table(db, "LibraryFile"):
        file = _row(db, "SELECT * FROM `LibraryFile` WHERE `editionId` = :edition_id AND `volumeId` = :volume_id ORDER BY `sortOrder` ASC LIMIT 1", {"edition_id": edition_id, "volume_id": volume_id})
    else:
        file = None
    file = file or (_row(db, "SELECT * FROM `LibraryFile` WHERE `editionId` = :edition_id ORDER BY `sortOrder` ASC LIMIT 1", {"edition_id": edition_id}) if _has_table(db, "LibraryFile") else None)
    return _send_file(_stored_path((file or {}).get("path"), settings), request, user.id, media_type=(file or {}).get("mimeType"), name=Path((file or {}).get("path") or "file").name, route="edition-file", file_id=(file or {}).get("id") or edition_id)


@router.get("/works/{work_id}/cover")
@router.get("/editions/{edition_id}/cover")
@router.get("/volumes/{volume_id}/cover")
def get_cover(request: Request, work_id: str | None = None, edition_id: str | None = None, volume_id: str | None = None, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    row = None
    if work_id and _has_table(db, "LibraryWork"):
        row = _row(db, "SELECT `coverPath` FROM `LibraryWork` WHERE `id` = :id", {"id": work_id})
    elif edition_id and _has_table(db, "LibraryEdition"):
        row = _row(db, "SELECT `coverPath` FROM `LibraryEdition` WHERE `id` = :id", {"id": edition_id})
    elif volume_id and _has_table(db, "LibraryVolume"):
        row = _row(db, "SELECT `coverPath` FROM `LibraryVolume` WHERE `id` = :id", {"id": volume_id})
    cover_id = work_id or edition_id or volume_id or "cover"
    return _send_file(_stored_path((row or {}).get("coverPath"), settings), request, user.id, route="cover", file_id=cover_id)


@router.get("/metadata/cover-proxy")
def metadata_cover_proxy(url: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    if not url.startswith(("http://", "https://")):
        return fail("封面地址不支持", status_code=400)
    remote_request = UrlRequest(url, headers={"Accept": "image/*,*/*", "User-Agent": "Shuku Starship Python", "Referer": "https://book.douban.com/"})
    try:
        with urlopen(remote_request, timeout=20) as remote_response:
            content_type = remote_response.headers.get("content-type") or "image/jpeg"
            if not content_type.lower().startswith("image/"):
                return fail("远程地址不是图片", status_code=400)
            data = remote_response.read(8 * 1024 * 1024)
    except Exception as exc:
        logger.warning("failed to proxy metadata cover url=%s error=%s", url, exc)
        return fail("封面预览加载失败", status_code=502)
    return Response(data, media_type=content_type, headers={"Cache-Control": "private, max-age=86400"})


def _preferred_work_cover_path(db: Session, work_id: str) -> str | None:
    work = _row(db, "SELECT `primaryEditionId` FROM `LibraryWork` WHERE `id` = :work_id", {"work_id": work_id}) if _has_table(db, "LibraryWork") else None
    primary_edition_id = (work or {}).get("primaryEditionId")
    if primary_edition_id and _has_table(db, "LibraryVolume"):
        volume = _row(
            db,
            """
            SELECT `coverPath`
            FROM `LibraryVolume`
            WHERE `editionId` = :edition_id AND `coverPath` IS NOT NULL AND `coverPath` != ''
            ORDER BY
                CASE WHEN `volumeIndex` IS NULL THEN 1 ELSE 0 END ASC,
                `volumeIndex` ASC,
                `sortOrder` ASC,
                `createdAt` ASC
            LIMIT 1
            """,
            {"edition_id": primary_edition_id},
        )
        if volume and volume.get("coverPath"):
            return str(volume["coverPath"])
    if primary_edition_id and _has_table(db, "LibraryEdition"):
        edition = _row(db, "SELECT `coverPath` FROM `LibraryEdition` WHERE `id` = :edition_id", {"edition_id": primary_edition_id})
        if edition and edition.get("coverPath"):
            return str(edition["coverPath"])
    edition = _row(
        db,
        """
        SELECT `coverPath`
        FROM `LibraryEdition`
        WHERE `workId` = :work_id AND `hidden` = 0 AND `coverPath` IS NOT NULL AND `coverPath` != ''
        ORDER BY CASE WHEN `primary` = 1 THEN 0 ELSE 1 END ASC, `createdAt` ASC
        LIMIT 1
        """,
        {"work_id": work_id},
    ) if _has_table(db, "LibraryEdition") else None
    return str(edition["coverPath"]) if edition and edition.get("coverPath") else None


@router.post("/works/{work_id}/cover/upload")
async def upload_cover(work_id: str, request: Request, cover: UploadFile = File(...), db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    target_dir = settings.resolved_storage_root / "covers"
    target_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(cover.filename or "cover.jpg").suffix or ".jpg"
    target = target_dir / f"{work_id}{suffix}"
    with target.open("wb") as handle:
        shutil.copyfileobj(cover.file, handle)
    relative = str(target.relative_to(settings.resolved_storage_root))
    _update(db, "LibraryWork", work_id, {"coverPath": relative, "coverStatus": "READY", "updatedAt": _now()})
    return ok({"bookId": work_id, "coverUrl": f"/api/works/{work_id}/cover?size=medium&v={int(_now().timestamp())}"})


@router.post("/works/{work_id}/cover/regenerate")
def regenerate_cover(work_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    cover_path = _preferred_work_cover_path(db, work_id)
    if not cover_path:
        return fail("没有可用的卷册封面", status_code=404)
    _update(db, "LibraryWork", work_id, {"coverPath": cover_path, "coverStatus": "READY", "updatedAt": _now()})
    return ok({"bookId": work_id, "coverUrl": f"/api/works/{work_id}/cover?size=medium&v={int(_now().timestamp())}"})


@router.get("/volumes/{volume_id}/pages")
def list_volume_pages(volume_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    units = _rows(db, "SELECT * FROM `LibraryReadingUnit` WHERE `volumeId` = :volume_id AND LOWER(`unitType`) = 'page' ORDER BY `sortOrder` ASC", {"volume_id": volume_id}) if _has_table(db, "LibraryReadingUnit") else []
    if not units:
        _ensure_volume_page_index(db, settings, volume_id)
        units = _rows(db, "SELECT * FROM `LibraryReadingUnit` WHERE `volumeId` = :volume_id AND LOWER(`unitType`) = 'page' ORDER BY `sortOrder` ASC", {"volume_id": volume_id}) if _has_table(db, "LibraryReadingUnit") else []
    return ok({"pages": units, "total": len(units)})


@router.get("/volumes/{volume_id}/pages/{page_index}")
def get_volume_page(volume_id: str, page_index: int, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    unit = _row(db, "SELECT * FROM `LibraryReadingUnit` WHERE `volumeId` = :volume_id AND LOWER(`unitType`) = 'page' AND `sortOrder` = :sort_order", {"volume_id": volume_id, "sort_order": page_index}) if _has_table(db, "LibraryReadingUnit") else None
    if not unit:
        _ensure_volume_page_index(db, settings, volume_id)
        unit = _row(db, "SELECT * FROM `LibraryReadingUnit` WHERE `volumeId` = :volume_id AND LOWER(`unitType`) = 'page' AND `sortOrder` = :sort_order", {"volume_id": volume_id, "sort_order": page_index}) if _has_table(db, "LibraryReadingUnit") else None
        if not unit:
            return fail("页面不存在", status_code=404)
    file = _row(db, "SELECT * FROM `LibraryFile` WHERE `id` = :id", {"id": unit.get("fileId")}) if _has_table(db, "LibraryFile") and unit.get("fileId") else None
    if file and file.get("kind") == "COMIC":
        metadata = _parse_json(unit.get("metadataJson"), {})
        entry_name = metadata.get("zipEntryName") or unit.get("href")
        return _send_zip_entry(_stored_path(file.get("path"), settings), entry_name, request, user.id, unit.get("mediaType"), route="volume-page-zip", file_id=unit.get("id") or f"{volume_id}:{page_index}")
    return _send_file(_stored_path(unit.get("href"), settings), request, user.id, route="volume-page", file_id=unit.get("id") or f"{volume_id}:{page_index}")


def _ensure_volume_page_index(db: Session, settings: Settings, volume_id: str) -> int:
    if not all(_has_table(db, table) for table in ["LibraryVolume", "LibraryFile", "LibraryReadingUnit"]):
        return 0
    existing = db.execute(text("SELECT COUNT(*) FROM `LibraryReadingUnit` WHERE `volumeId` = :volume_id AND LOWER(`unitType`) = 'page'"), {"volume_id": volume_id}).scalar() or 0
    if existing:
        return int(existing)
    volume = _row(db, "SELECT * FROM `LibraryVolume` WHERE `id` = :id", {"id": volume_id})
    if not volume:
        return 0
    file = _row(db, "SELECT * FROM `LibraryFile` WHERE `volumeId` = :volume_id AND `kind` = 'COMIC' ORDER BY `sortOrder` ASC LIMIT 1", {"volume_id": volume_id})
    if not file:
        file = _row(db, "SELECT * FROM `LibraryFile` WHERE `editionId` = :edition_id AND `kind` = 'COMIC' ORDER BY `sortOrder` ASC LIMIT 1", {"edition_id": volume.get("editionId")})
    archive_path = _stored_path((file or {}).get("path"), settings)
    if not file or not archive_path:
        return 0
    try:
        parsed = parse_comic_archive(archive_path, Path(file.get("path") or archive_path).name)
    except Exception as exc:
        logger.warning("failed to rebuild comic page index volume=%s file=%s error=%s", volume_id, file.get("id"), exc)
        return 0
    now = _now()
    rows = [
        {
            "id": f"py_{time_ns()}_{page['index']}",
            "editionId": volume.get("editionId"),
            "volumeId": volume_id,
            "fileId": file.get("id"),
            "unitType": "page",
            "title": page["title"],
            "href": page["entryPath"],
            "mediaType": page["mediaType"],
            "sortOrder": page["index"],
            "size": page.get("size"),
            "metadataJson": _json_text(
                {
                    "zipEntryName": page["entryPath"],
                    "originalName": Path(page["entryPath"]).name,
                    "pageInVolume": page["index"],
                    "pageInSection": page["index"],
                    "volumeIndex": volume.get("volumeIndex"),
                    "sourceFileName": Path(file.get("path") or archive_path).name,
                }
            ),
            "createdAt": now,
            "updatedAt": now,
        }
        for page in parsed["pages"]
    ]
    if rows:
        try:
            db.execute(
                text(
                    """
                    INSERT INTO `LibraryReadingUnit`
                    (`id`, `editionId`, `volumeId`, `fileId`, `unitType`, `title`, `href`, `mediaType`, `sortOrder`, `size`, `metadataJson`, `createdAt`, `updatedAt`)
                    VALUES
                    (:id, :editionId, :volumeId, :fileId, :unitType, :title, :href, :mediaType, :sortOrder, :size, :metadataJson, :createdAt, :updatedAt)
                    """
                ),
                rows,
            )
            db.commit()
        except IntegrityError:
            db.rollback()
            existing = db.execute(text("SELECT COUNT(*) FROM `LibraryReadingUnit` WHERE `volumeId` = :volume_id AND LOWER(`unitType`) = 'page'"), {"volume_id": volume_id}).scalar() or 0
            if existing:
                return int(existing)
            raise
    count = len(parsed["pages"])
    _update(db, "LibraryVolume", volume_id, {"pageCount": count, "updatedAt": now})
    if volume.get("editionId") and _has_table(db, "LibraryVolume") and _has_table(db, "LibraryEdition"):
        total = db.execute(text("SELECT COALESCE(SUM(`pageCount`), 0) FROM `LibraryVolume` WHERE `editionId` = :edition_id"), {"edition_id": volume.get("editionId")}).scalar() or count
        _update(db, "LibraryEdition", volume.get("editionId"), {"pageCount": int(total), "updatedAt": now})
    return count


def _list_table_response(db: Session, table: str, key: str, order: str = "`createdAt` DESC") -> Response:
    rows = _rows(db, f"SELECT * FROM `{table}` ORDER BY {order}") if _has_table(db, table) else []
    return ok({key: rows})


def _serialize_metadata_suggestion(suggestion: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": suggestion.get("id"),
        "field": suggestion.get("field"),
        "currentValue": _parse_json(suggestion.get("currentValue"), suggestion.get("currentValue")),
        "suggestedValue": _parse_json(suggestion.get("suggestedValue"), suggestion.get("suggestedValue")),
        "source": suggestion.get("source") or "rule",
        "confidence": suggestion.get("confidence") or 0,
        "reason": suggestion.get("reason") or "",
        "status": suggestion.get("status") or "PENDING",
    }


def _serialize_duplicate_candidate(duplicate: dict[str, Any]) -> dict[str, Any]:
    reasons = _parse_json(duplicate.get("reasons"), [])
    return {
        "id": duplicate.get("id"),
        "targetWorkId": duplicate.get("targetWorkId"),
        "reasons": reasons if isinstance(reasons, list) else [],
        "confidence": duplicate.get("confidence") or 0,
        "suggestedAction": duplicate.get("suggestedAction") or "KEEP_SEPARATE",
        "status": duplicate.get("status") or "PENDING",
    }


def _organize_job_view(db: Session, job: dict[str, Any], user_id: str | None, pending_only: bool = False) -> dict[str, Any] | None:
    work = _get_work(db, str(job.get("workId") or ""))
    if not work or work.get("hidden"):
        return None
    status_filter = " AND `status` = 'PENDING'" if pending_only else ""
    suggestions = (
        _rows(
            db,
            f"SELECT * FROM `MetadataSuggestion` WHERE `jobId` = :job_id{status_filter} ORDER BY `status` ASC, `confidence` DESC, `createdAt` ASC",
            {"job_id": job.get("id")},
        )
        if _has_table(db, "MetadataSuggestion")
        else []
    )
    duplicates = (
        _rows(
            db,
            f"SELECT * FROM `DuplicateCandidate` WHERE `jobId` = :job_id{status_filter} ORDER BY `status` ASC, `confidence` DESC, `createdAt` ASC",
            {"job_id": job.get("id")},
        )
        if _has_table(db, "DuplicateCandidate")
        else []
    )
    return {
        "id": job.get("id"),
        "status": job.get("status") or "REVIEWING",
        "issueCodes": _parse_json(job.get("issueCodes"), []),
        "summary": job.get("summary"),
        "errorSummary": job.get("errorSummary"),
        "updatedAt": _dt(job.get("updatedAt")),
        "book": _work_view(db, work, user_id),
        "suggestions": [_serialize_metadata_suggestion(suggestion) for suggestion in suggestions],
        "duplicates": [_serialize_duplicate_candidate(duplicate) for duplicate in duplicates],
    }


def _friendly_import_error(message: str | None) -> str | None:
    text_value = message or ""
    if re.search(r"EACCES|permission|权限", text_value, re.I):
        return "权限不足：请确认容器用户可以读取该目录和文件。"
    if re.search(r"ENOENT|not found|不存在", text_value, re.I):
        return "文件不存在：可能已被移动、删除，或监控目录配置已变化。"
    if re.search(r"unsupported|format|格式", text_value, re.I):
        return "格式暂不支持：请确认文件是 EPUB、CBZ 或 ZIP。"
    if re.search(r"zip|archive|corrupt|invalid|损坏", text_value, re.I):
        return "压缩包可能损坏：请重新复制文件或用本地工具测试压缩包。"
    return "导入失败：请检查文件完整性和格式。" if text_value else None


def _display_path_name(value: Any) -> str:
    text_value = str(value or "")
    parts = [part for part in re.split(r"[\\/]+", text_value) if part]
    return parts[-1] if parts else text_value


def _serialize_import_log(log: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": log.get("id"),
        "level": log.get("level") or "info",
        "message": log.get("message") or "",
        "createdAt": _dt(log.get("createdAt")),
    }


def _import_task_view(db: Session, task: dict[str, Any], log_limit: int = 20) -> dict[str, Any]:
    monitor_folder = None
    if task.get("monitorFolderId") and _has_table(db, "MonitorFolder"):
        monitor_folder = _row(db, "SELECT * FROM `MonitorFolder` WHERE `id` = :id", {"id": task.get("monitorFolderId")})
    book = None
    if task.get("workId") and _has_table(db, "LibraryWork"):
        work = _row(db, "SELECT `id`, `title` FROM `LibraryWork` WHERE `id` = :id", {"id": task.get("workId")})
        if work:
            book = {"id": work.get("id"), "title": work.get("title") or "未命名作品"}
    logs = (
        _rows(
            db,
            "SELECT * FROM `ImportLog` WHERE `importTaskId` = :task_id ORDER BY `createdAt` DESC LIMIT :limit",
            {"task_id": task.get("id"), "limit": log_limit},
        )
        if _has_table(db, "ImportLog")
        else []
    )
    view = dict(task)
    view.update(
        {
            "sourcePath": _display_path_name(task.get("sourcePath")),
            "managedFilePath": _display_path_name(task.get("managedFilePath")) if task.get("managedFilePath") else None,
            "progress": task.get("progress") or 0,
            "duplicate": bool(task.get("duplicate")),
            "friendlyError": _friendly_import_error(task.get("errorSummary")),
            "createdAt": _dt(task.get("createdAt")),
            "finishedAt": _dt(task.get("finishedAt")),
            "monitorFolder": monitor_folder,
            "book": book,
            "logs": [_serialize_import_log(log) for log in logs],
        }
    )
    return view


@router.get("/sources")
def list_sources(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    sources = _rows(db, "SELECT * FROM `Source` ORDER BY `priority` ASC, `createdAt` DESC") if _has_table(db, "Source") else []
    return ok({"sources": [_source_view(source) for source in sources]})


@router.post("/sources")
async def create_source(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    provider_type = payload.get("providerType") or payload.get("type") or "manual"
    config = _merge_source_config_for_write(None, provider_type, payload.get("config", {}))
    source = _insert(db, "Source", {"id": f"py_{time_ns()}", "name": payload.get("name") or "新来源", "kind": payload.get("kind") or "search", "providerType": provider_type, "enabled": bool(payload.get("enabled", True)), "priority": int(payload.get("priority", 100)), "config": _json_text(config), "credentialsKey": payload.get("credentialsKey"), "capabilities": _json_text(payload.get("capabilities", {})), "rateLimit": _json_text(payload.get("rateLimit", {})), "createdAt": _now(), "updatedAt": _now()})
    return ok({"source": _source_view(source)}, status_code=201)


@router.put("/sources/{source_id}")
@router.patch("/sources/{source_id}")
async def update_source(source_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    existing = _row(db, "SELECT * FROM `Source` WHERE `id` = :id", {"id": source_id}) if _has_table(db, "Source") else None
    if not existing:
        return fail("来源不存在", status_code=404)
    next_provider_type = payload.get("providerType") or existing.get("providerType") or "manual"
    values = {}
    for key, value in payload.items():
        if key == "config":
            values[key] = _json_text(_merge_source_config_for_write(existing, next_provider_type, value))
        elif key in {"capabilities", "rateLimit"}:
            values[key] = _json_text(value)
        else:
            values[key] = value
    source = _update(db, "Source", source_id, values)
    if not source:
        return fail("来源不存在", status_code=404)
    return ok({"source": _source_view(source)})


@router.get("/sources/{source_id}")
def get_source(source_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    source = _row(db, "SELECT * FROM `Source` WHERE `id` = :id", {"id": source_id}) if _has_table(db, "Source") else None
    if not source:
        return fail("来源不存在", status_code=404)
    return ok({"source": _source_view(source)})


@router.delete("/sources/{source_id}")
def delete_source(source_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return ok({"deleted": _delete(db, "Source", source_id), "id": source_id})


@router.post("/sources/{source_id}/test")
def test_source(source_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    source = _row(db, "SELECT * FROM `Source` WHERE `id` = :id", {"id": source_id}) if _has_table(db, "Source") else None
    if not source:
        return fail("源不存在", status_code=404)
    if not str(source.get("name") or "").strip():
        result = {"status": "failed", "message": "源名称为空"}
    elif source.get("providerType") not in PROVIDER_CAPABILITIES:
        result = {"status": "failed", "message": "这个来源暂不支持搜索或连接测试。"}
    else:
        provider_result = test_source_provider(source)
        result = {"status": "ok" if provider_result.ok else "failed", "message": provider_result.message, "details": provider_result.details}
    updated = _update(
        db,
        "Source",
        source_id,
        {"lastTestAt": _now(), "lastTestStatus": result["status"], "lastError": None if result["status"] == "ok" else result["message"]},
    )
    return ok({"result": result, "source": _source_view(updated) if updated else None})


@router.post("/sources/{source_id}/search")
async def search_source(source_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    keyword = str(payload.get("keyword") or payload.get("query") or "").strip()
    if not keyword:
        return fail("请输入搜索关键词", status_code=400)
    source = _row(db, "SELECT * FROM `Source` WHERE `id` = :id", {"id": source_id}) if _has_table(db, "Source") else None
    if not source:
        return fail("源不存在", status_code=404)
    if source.get("enabled") is False:
        return fail("源已禁用，请启用后再搜索", status_code=400)
    try:
        results, provider = search_source_provider(
            source,
            keyword,
            kind=payload.get("kind"),
            page=_positive_int(payload.get("page"), 1, 9999),
            page_size=_positive_int(payload.get("pageSize"), 20, 100),
        )
    except ValueError as exc:
        return fail(str(exc), status_code=400)
    records = [_upsert_source_record(db, source, result, "saved") for result in results] if payload.get("saveResults") else []
    return ok({"results": results, "records": records, "provider": provider})


def _source_record_values(source: dict[str, Any], result: dict[str, Any], status: str) -> dict[str, Any]:
    return {
        "sourceId": source["id"],
        "providerType": result.get("providerType") or source.get("providerType"),
        "externalId": result.get("externalId"),
        "title": (result.get("title") or "").strip(),
        "subtitle": result.get("subtitle"),
        "author": result.get("author"),
        "description": result.get("description"),
        "coverUrl": result.get("coverUrl"),
        "externalUrl": result.get("externalUrl"),
        "format": result.get("format"),
        "size": result.get("size"),
        "language": result.get("language"),
        "publishedAt": result.get("publishedAt"),
        "downloadAvailable": bool(result.get("downloadAvailable")),
        "downloadMeta": _json_text(result.get("downloadMeta")) if result.get("downloadMeta") is not None else None,
        "raw": _json_text(result.get("raw")) if result.get("raw") is not None else None,
        "status": status,
        "updatedAt": _now(),
    }


def _upsert_source_record(db: Session, source: dict[str, Any], result: dict[str, Any], status: str) -> dict[str, Any]:
    if not _has_table(db, "SourceSearchRecord"):
        return result
    existing = _row(
        db,
        "SELECT * FROM `SourceSearchRecord` WHERE `sourceId` = :source_id AND `externalId` = :external_id",
        {"source_id": source["id"], "external_id": result.get("externalId")},
    )
    values = _source_record_values(source, result, status)
    if existing:
        return _update(db, "SourceSearchRecord", existing["id"], values) or existing
    values["id"] = f"py_{time_ns()}"
    values["createdAt"] = _now()
    return _insert(db, "SourceSearchRecord", values)


def _source_record_view(db: Session, record: dict[str, Any]) -> dict[str, Any]:
    source_name = None
    if record.get("sourceId") and _has_table(db, "Source"):
        source = _row(db, "SELECT `name` FROM `Source` WHERE `id` = :id", {"id": record.get("sourceId")})
        source_name = (source or {}).get("name")
    return {
        **record,
        "downloadMeta": _parse_json(record.get("downloadMeta"), record.get("downloadMeta")),
        "raw": _parse_json(record.get("raw"), record.get("raw")),
        "sourceName": source_name,
    }


@router.get("/source-search-records")
def list_source_records(request: Request, sourceId: str | None = None, status: str | None = None, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    if not _has_table(db, "SourceSearchRecord"):
        return ok({"records": [], "total": 0})
    where = []
    params = {}
    if sourceId:
        where.append("`sourceId` = :source_id")
        params["source_id"] = sourceId
    provider_type = request.query_params.get("providerType")
    keyword = (request.query_params.get("keyword") or "").strip()
    if status:
        where.append("`status` = :status")
        params["status"] = status
    if provider_type and provider_type != "all":
        where.append("`providerType` = :provider_type")
        params["provider_type"] = provider_type
    if keyword:
        where.append("(`title` LIKE :keyword OR `author` LIKE :keyword)")
        params["keyword"] = f"%{keyword}%"
    sql_where = f" WHERE {' AND '.join(where)}" if where else ""
    records = _rows(db, f"SELECT * FROM `SourceSearchRecord`{sql_where} ORDER BY `createdAt` DESC LIMIT 100", params)
    return ok({"records": [_source_record_view(db, record) for record in records], "total": len(records)})


@router.post("/source-search-records")
async def create_source_record(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    record = _insert(db, "SourceSearchRecord", {"id": f"py_{time_ns()}", "sourceId": payload.get("sourceId"), "providerType": payload.get("providerType") or "manual", "externalId": payload.get("externalId") or f"manual:{time_ns()}", "title": payload.get("title") or "未命名结果", "subtitle": payload.get("subtitle"), "author": payload.get("author"), "description": payload.get("description"), "coverUrl": payload.get("coverUrl"), "externalUrl": payload.get("externalUrl"), "format": payload.get("format"), "size": payload.get("size"), "language": payload.get("language"), "downloadAvailable": bool(payload.get("downloadAvailable", False)), "downloadMeta": _json_text(payload.get("downloadMeta", {})), "raw": _json_text(payload.get("raw", payload)), "status": payload.get("status") or "new", "createdAt": _now(), "updatedAt": _now()})
    return ok({"record": record}, status_code=201)


@router.get("/source-search-records/{record_id}")
def get_source_record(record_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    record = _row(db, "SELECT * FROM `SourceSearchRecord` WHERE `id` = :id", {"id": record_id}) if _has_table(db, "SourceSearchRecord") else None
    if not record:
        return fail("搜索记录不存在", status_code=404)
    return ok({"record": record})


@router.delete("/source-search-records/{record_id}")
def delete_source_record(record_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return ok({"deleted": _delete(db, "SourceSearchRecord", record_id), "id": record_id})


@router.put("/source-search-records/{record_id}")
async def update_source_record(record_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    allowed = {"status", "title", "subtitle", "author", "description", "externalUrl", "format", "size", "language"}
    record = _update(db, "SourceSearchRecord", record_id, {key: value for key, value in payload.items() if key in allowed})
    if not record:
        return fail("搜索记录不存在", status_code=404)
    return ok({"record": record})


@router.post("/source-search-records/{record_id}/ignore")
@router.post("/source-search-records/{record_id}/save")
def mark_source_record(record_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    status_value = "ignored" if request.url.path.endswith("/ignore") else "saved"
    record = _update(db, "SourceSearchRecord", record_id, {"status": status_value, "updatedAt": _now()})
    return ok({"record": record, "status": status_value})


@router.post("/source-search-records/{record_id}/create-download-task")
def create_download_from_record(record_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    record = _row(db, "SELECT * FROM `SourceSearchRecord` WHERE `id` = :id", {"id": record_id}) if _has_table(db, "SourceSearchRecord") else None
    if not record:
        return fail("搜索记录不存在", status_code=404)
    if not record.get("downloadAvailable"):
        return fail("该搜索结果不可下载", status_code=400)
    if not has_usable_download_meta(record.get("providerType") or "", record.get("downloadMeta")):
        return fail("该搜索结果缺少可用下载信息", status_code=400)
    existing = find_active_download_task(db, record_id)
    if existing:
        if record.get("status") != "download_created":
            record = _update(db, "SourceSearchRecord", record_id, {"status": "download_created", "updatedAt": _now()}) or record
        return ok({"task": existing, "record": record, "alreadyQueued": True})
    remote_ref = create_remote_ref_from_search_record(record)
    task_type = infer_download_task_type(record.get("providerType") or "", record.get("downloadMeta"))
    task = (
        _insert(
            db,
            "DownloadTask",
            {
                "id": f"py_{time_ns()}",
                "sourceId": record.get("sourceId"),
                "searchRecordId": record_id,
                "type": task_type,
                "status": "queued",
                "displayName": record.get("title") or "下载任务",
                "remoteRef": _json_text(remote_ref),
                "savePath": str(settings.resolved_download_inbox_path),
                "progress": 0,
                "createdAt": _now(),
                "updatedAt": _now(),
            },
        )
        if _has_table(db, "DownloadTask")
        else {"id": None}
    )
    record = _update(db, "SourceSearchRecord", record_id, {"status": "download_created", "updatedAt": _now()}) or record
    return ok({"task": task, "record": record}, status_code=201)


@router.get("/download-tasks")
def list_download_tasks(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    tasks = _rows(db, "SELECT * FROM `DownloadTask` ORDER BY `createdAt` DESC") if _has_table(db, "DownloadTask") else []
    source_names: dict[str, str] = {}
    if _has_table(db, "Source"):
        for source in _rows(db, "SELECT `id`, `name` FROM `Source`"):
            if source.get("id"):
                source_names[str(source["id"])] = str(source.get("name") or "")
    return ok({"tasks": [{**task, "remoteRef": _parse_json(task.get("remoteRef"), task.get("remoteRef")), "sourceName": source_names.get(str(task.get("sourceId")))} for task in tasks]})


@router.post("/download-tasks")
async def create_download_task(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    task = _insert(db, "DownloadTask", {"id": f"py_{time_ns()}", "sourceId": payload.get("sourceId"), "searchRecordId": payload.get("searchRecordId"), "bookId": payload.get("bookId"), "type": payload.get("type") or "manual", "status": payload.get("status") or "queued", "displayName": payload.get("displayName") or payload.get("name") or "下载任务", "remoteRef": _json_text(payload.get("remoteRef", {})), "savePath": payload.get("savePath") or str(settings.resolved_download_inbox_path), "filePath": payload.get("filePath"), "errorMessage": payload.get("errorMessage"), "progress": payload.get("progress") if payload.get("progress") is not None else 0, "createdAt": _now(), "updatedAt": _now()}) if _has_table(db, "DownloadTask") else {"id": None}
    _record_system_event(db, level="info", source="download", actor_type="admin", actor_id=user.id, action="created", target_type="downloadTask", target_id=task.get("id"), message=f"创建下载任务：{task.get('displayName')}", metadata={"status": task.get("status"), "type": task.get("type")})
    return ok({"task": task}, status_code=201)


@router.get("/download-tasks/{task_id}")
def get_download_task(task_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    task = _row(db, "SELECT * FROM `DownloadTask` WHERE `id` = :id", {"id": task_id}) if _has_table(db, "DownloadTask") else None
    if not task:
        return fail("下载任务不存在", status_code=404)
    return ok({"task": task})


@router.delete("/download-tasks/{task_id}")
def delete_download_task(task_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    task = _row(db, "SELECT * FROM `DownloadTask` WHERE `id` = :id", {"id": task_id}) if _has_table(db, "DownloadTask") else None
    deleted = _delete(db, "DownloadTask", task_id)
    if deleted:
        _record_system_event(db, level="warning", source="download", actor_type="admin", actor_id=user.id, action="deleted", target_type="downloadTask", target_id=task_id, message=f"删除下载任务：{(task or {}).get('displayName') or task_id}", metadata={"status": (task or {}).get("status")})
    return ok({"deleted": deleted, "id": task_id})


@router.put("/download-tasks/{task_id}")
async def update_download_task(task_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    allowed = {"type", "status", "displayName", "savePath", "filePath", "errorMessage", "progress"}
    values = {key: value for key, value in payload.items() if key in allowed}
    if "remoteRef" in payload:
        values["remoteRef"] = _json_text(payload["remoteRef"])
    task = _update(db, "DownloadTask", task_id, values)
    if not task:
        return fail("下载任务不存在", status_code=404)
    _record_system_event(db, level="error" if task.get("status") == "failed" else "info", source="download", actor_type="admin", actor_id=user.id, action="updated", target_type="downloadTask", target_id=task_id, message=f"更新下载任务：{task.get('displayName')}", metadata={"changes": values, "status": task.get("status"), "errorMessage": task.get("errorMessage")})
    return ok({"task": task})


@router.post("/download-tasks/{task_id}/start")
@router.post("/download-tasks/{task_id}/retry")
@router.post("/download-tasks/{task_id}/cancel")
@router.post("/download-tasks/{task_id}/import")
def mutate_download_task(task_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    action = request.url.path.rsplit("/", 1)[-1]
    task = _row(db, "SELECT * FROM `DownloadTask` WHERE `id` = :id", {"id": task_id}) if _has_table(db, "DownloadTask") else None
    if not task:
        return fail("下载任务不存在", status_code=404)
    if action in {"start", "retry"}:
        if action == "retry":
            if task.get("status") not in {"queued", "failed", "cancelled", "PENDING", "FAILED", "CANCELLED"}:
                return fail("只有等待中、失败或已取消的任务可以重新排队", status_code=400)
            task = _update(db, "DownloadTask", task_id, {"status": "queued", "progress": 0, "errorMessage": None, "updatedAt": _now()})
            _record_system_event(db, level="info", source="download", actor_type="admin", actor_id=user.id, action="retry", target_type="downloadTask", target_id=task_id, message=f"重新排队下载任务：{task.get('displayName')}", metadata={"status": task.get("status")})
            return ok({"task": task, "action": action})
        if task.get("status") not in {"queued", "failed", "PENDING", "FAILED"}:
            return fail("只有等待中或失败的任务可以开始下载", status_code=400)
        result = execute_download_task(db, settings, task_id)
        _record_system_event(db, level="error" if result.task.get("status") == "failed" else "info", source="download", actor_type="admin", actor_id=user.id, action="start", target_type="downloadTask", target_id=task_id, message=f"执行下载任务：{result.task.get('displayName')}", metadata={"status": result.task.get("status"), "errorMessage": result.task.get("errorMessage"), "filePath": result.task.get("filePath")})
        return ok({"task": result.task, "action": action})
    if action == "cancel":
        task = _update(db, "DownloadTask", task_id, {"status": "cancelled", "updatedAt": _now()})
        _record_system_event(db, level="warning", source="download", actor_type="admin", actor_id=user.id, action="cancelled", target_type="downloadTask", target_id=task_id, message=f"取消下载任务：{task.get('displayName')}", metadata={"status": task.get("status")})
        return ok({"task": task, "action": action})
    try:
        result = import_download_task(db, settings, task_id)
    except ValueError as exc:
        _record_system_event(db, level="error", source="download", actor_type="admin", actor_id=user.id, action="import.failed", target_type="downloadTask", target_id=task_id, message=f"下载导入失败：{task.get('displayName')}", metadata={"error": str(exc)})
        return fail(str(exc), status_code=400)
    payload = {"task": result.task, "action": action}
    if result.import_result:
        payload["importResult"] = {
            "bookId": result.import_result.book_id,
            "workId": result.import_result.work_id,
            "editionId": result.import_result.edition_id,
            "volumeId": result.import_result.volume_id,
            "title": result.import_result.title,
            "type": result.import_result.type,
            "format": result.import_result.format,
            "totalUnits": result.import_result.total_units,
            "importStatus": result.import_result.import_status,
        }
    _record_system_event(db, level="error" if result.task.get("status") == "failed" else "info", source="download", actor_type="admin", actor_id=user.id, action="imported", target_type="downloadTask", target_id=task_id, message=f"下载文件导入书库：{result.task.get('displayName')}", metadata={"status": result.task.get("status"), "workId": getattr(result.import_result, "work_id", None) if result.import_result else None, "errorMessage": result.task.get("errorMessage")})
    return ok(payload, status_code=400 if result.task.get("status") == "failed" else 200)


@router.get("/import-tasks")
def list_import_tasks(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    tasks = (
        _rows(db, "SELECT * FROM `ImportTask` ORDER BY `createdAt` DESC LIMIT 50")
        if _has_table(db, "ImportTask")
        else []
    )
    views = [_import_task_view(db, task, log_limit=20) for task in tasks]
    summary = {
        "added": sum(1 for task in views if task.get("status") == "COMPLETED" and not task.get("duplicate")),
        "updated": 0,
        "skipped": sum(1 for task in views if task.get("duplicate")),
        "failed": sum(1 for task in views if task.get("status") == "FAILED"),
    }
    return ok({"tasks": views, "summary": summary})


@router.delete("/import-tasks")
def clear_import_tasks(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    deleted = 0
    if _has_table(db, "ImportTask"):
        result = db.execute(text("DELETE FROM `ImportTask` WHERE `status` IN ('COMPLETED', 'FAILED')"))
        db.commit()
        deleted = result.rowcount or 0
    if deleted:
        _record_system_event(db, level="info", source="import", actor_type="admin", actor_id=user.id, action="tasks.cleared", target_type="importTask", message=f"清空已结束导入记录 {deleted} 条", metadata={"deleted": deleted})
    return ok({"deleted": deleted})


@router.post("/import-tasks/rescan")
def rescan_import_tasks(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    requested_at = _now().isoformat()
    if _has_table(db, "SystemSetting"):
        existing = _row(db, "SELECT `key` FROM `SystemSetting` WHERE `key` = :key", {"key": "monitor.rescanRequestedAt"})
        if existing:
            db.execute(text("UPDATE `SystemSetting` SET `value` = :value, `updatedAt` = :updated_at WHERE `key` = :key"), {"key": "monitor.rescanRequestedAt", "value": requested_at, "updated_at": _now()})
        else:
            db.execute(
                text("INSERT INTO `SystemSetting` (`key`, `value`, `createdAt`, `updatedAt`) VALUES (:key, :value, :created_at, :updated_at)"),
                {"key": "monitor.rescanRequestedAt", "value": requested_at, "created_at": _now(), "updated_at": _now()},
            )
        db.commit()
    _record_system_event(db, level="info", source="import", actor_type="admin", actor_id=user.id, action="rescan.requested", target_type="monitorFolder", message="请求重新识别监控文件夹", metadata={"requestedAt": requested_at})
    return ok({"requestedAt": requested_at})


@router.get("/import-tasks/{task_id}")
def get_import_task(task_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    task = _row(db, "SELECT * FROM `ImportTask` WHERE `id` = :id", {"id": task_id}) if _has_table(db, "ImportTask") else None
    if not task:
        return fail("导入任务不存在", status_code=404)
    return ok({"task": _import_task_view(db, task, log_limit=100)})


@router.get("/import-tasks/{task_id}/logs")
def get_import_logs(task_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    if not _has_table(db, "ImportTask") or not _row(db, "SELECT `id` FROM `ImportTask` WHERE `id` = :id", {"id": task_id}):
        return fail("导入任务不存在", status_code=404)
    page = _positive_int(request.query_params.get("page"), 1, 100000)
    page_size = _positive_int(request.query_params.get("pageSize"), 100, 200)
    level = request.query_params.get("level")
    where = "`importTaskId` = :task_id"
    params: dict[str, Any] = {"task_id": task_id, "limit": page_size, "offset": (page - 1) * page_size}
    if level:
        where += " AND `level` = :level"
        params["level"] = level.lower()
    total = _table_count(db, "ImportLog", where, params)
    logs = (
        _rows(db, f"SELECT * FROM `ImportLog` WHERE {where} ORDER BY `createdAt` DESC LIMIT :limit OFFSET :offset", params)
        if _has_table(db, "ImportLog")
        else []
    )
    return ok({"logs": [_serialize_import_log(log) for log in logs], "page": page, "pageSize": page_size, "total": total, "totalPages": max(1, (total + page_size - 1) // page_size)})


@router.get("/shelves")
def list_shelves(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return _list_table_response(db, "Shelf", "shelves", "`updatedAt` DESC")


@router.get("/shelves/{shelf_id}")
def get_shelf(shelf_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    shelf = _row(db, "SELECT * FROM `Shelf` WHERE `id` = :id", {"id": shelf_id}) if _has_table(db, "Shelf") else None
    if not shelf:
        return fail("书架不存在", status_code=404)
    work_ids = [row["workId"] for row in _rows(db, "SELECT `workId` FROM `ShelfWork` WHERE `shelfId` = :shelf_id ORDER BY `createdAt` ASC", {"shelf_id": shelf_id})] if _has_table(db, "ShelfWork") else []
    works = [_work_view(db, work, user.id) for work_id in work_ids if (work := _get_work(db, work_id))]
    return ok({"shelf": {**shelf, "workIds": work_ids, "works": works}})


@router.post("/shelves")
async def create_shelf(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    shelf = _insert(db, "Shelf", {"id": f"py_{time_ns()}", "name": payload.get("name") or "新书架", "description": payload.get("description"), "createdAt": _now(), "updatedAt": _now()})
    return ok({"shelf": shelf}, status_code=201)


@router.patch("/shelves/{shelf_id}")
async def update_shelf(shelf_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    shelf = _update(db, "Shelf", shelf_id, {"name": payload.get("name"), "description": payload.get("description"), "updatedAt": _now()})
    works = payload.get("workIds")
    if shelf and isinstance(works, list) and _has_table(db, "ShelfWork"):
        db.execute(text("DELETE FROM `ShelfWork` WHERE `shelfId` = :shelf_id"), {"shelf_id": shelf_id})
        for work_id in works:
            db.execute(text("INSERT INTO `ShelfWork` (`shelfId`, `workId`, `createdAt`) VALUES (:shelf_id, :work_id, :created_at)"), {"shelf_id": shelf_id, "work_id": work_id, "created_at": _now()})
        db.commit()
    return ok({"shelf": shelf})


@router.delete("/shelves/{shelf_id}")
def delete_shelf(shelf_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return ok({"deleted": _delete(db, "Shelf", shelf_id), "id": shelf_id})


@router.get("/organize/jobs")
def list_organize_jobs(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    page_size = _positive_int(request.query_params.get("pageSize"), 50, 200)
    rows = (
        _rows(
            db,
            """
            SELECT j.* FROM `OrganizeJob` j
            INNER JOIN `LibraryWork` w ON w.`id` = j.`workId`
            WHERE j.`status` IN ('PENDING', 'REVIEWING', 'FAILED') AND COALESCE(w.`hidden`, 0) = 0
            ORDER BY j.`updatedAt` DESC
            LIMIT :limit
            """,
            {"limit": page_size},
        )
        if _has_table(db, "OrganizeJob") and _has_table(db, "LibraryWork")
        else []
    )
    jobs = [view for row in rows if (view := _organize_job_view(db, row, getattr(user, "id", None), pending_only=True)) is not None]
    return ok({"jobs": jobs, "books": [job["book"] for job in jobs], "total": len(jobs)})


@router.get("/organize/pending")
def list_pending_organize(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    page_size = _positive_int(request.query_params.get("pageSize"), 50, 200)
    rows = (
        _rows(
            db,
            """
            SELECT j.* FROM `OrganizeJob` j
            INNER JOIN `LibraryWork` w ON w.`id` = j.`workId`
            WHERE j.`status` = 'REVIEWING' AND COALESCE(w.`hidden`, 0) = 0
            ORDER BY j.`updatedAt` DESC
            LIMIT :limit
            """,
            {"limit": page_size},
        )
        if _has_table(db, "OrganizeJob") and _has_table(db, "LibraryWork")
        else []
    )
    jobs = [view for row in rows if (view := _organize_job_view(db, row, getattr(user, "id", None), pending_only=True)) is not None]
    return ok({"jobs": jobs, "books": [job["book"] for job in jobs], "total": len(jobs)})


@router.get("/organize/jobs/{job_id}")
def get_organize_job(job_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    job = _row(db, "SELECT * FROM `OrganizeJob` WHERE `id` = :id", {"id": job_id}) if _has_table(db, "OrganizeJob") else None
    if not job:
        return fail("整理任务不存在", status_code=404)
    view = _organize_job_view(db, job, getattr(user, "id", None))
    if not view:
        return fail("整理任务不存在", status_code=404)
    return ok({"job": view})


@router.post("/organize/jobs/{job_id}/apply")
@router.post("/organize/jobs/{job_id}/refresh")
async def mutate_organize_job(job_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    action = request.url.path.rsplit("/", 1)[-1]
    payload = await request.json()
    try:
        if action == "refresh":
            providers = [str(provider) for provider in payload.get("providers") or [] if str(provider) in {"external", "bangumi", "douban", "ai"}]
            if providers:
                result = refresh_metadata_providers(db, job_id, providers, force=True)
                disabled = all(not item.get("enabled") for item in result["results"])
                errors = [item.get("error") for item in result["results"] if item.get("error")]
                usable = any(item.get("enabled") and not item.get("error") for item in result["results"])
                disabled_messages = [item.get("message") for item in result["results"] if item.get("message")]
                message = (
                    "；".join(disabled_messages) or "外部数据查询或 AI 识别尚未配置。"
                    if disabled
                    else f"元数据刷新失败：{'；'.join(errors)}"
                    if not usable and errors
                    else f"已刷新，新增 {result['added']} 条候选建议。"
                )
                return ok({**result, "enabled": usable, "message": message})
            refreshed = refresh_organize_job(db, job_id)
            return ok({"job": refreshed, "action": action, "enabled": True, "message": refreshed.get("summary") or "已刷新本地整理状态。"})
        result = apply_organize_job(db, job_id, payload)
        return ok(
            {
                "job": result.job,
                "action": action,
                "applied": result.applied,
                "appliedExternal": result.applied_external,
                "autoMarkedOrganized": result.auto_marked_organized,
                "dismissed": result.dismissed,
                "duplicateActionsApplied": result.duplicate_actions_applied,
            }
        )
    except ValueError as exc:
        return fail(str(exc), status_code=404 if "不存在" in str(exc) else 400)


@router.post("/organize/jobs/bulk-apply")
async def bulk_apply_organize_jobs(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    ids = payload.get("ids") or payload.get("jobIds") or []
    try:
        result = apply_organize_jobs_bulk(db, [str(job_id) for job_id in ids], payload)
        return ok({**result, "ids": ids})
    except ValueError as exc:
        return fail(str(exc), status_code=400)


@router.get("/backups")
def list_backups(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return ok({"backups": list_backup_archives(settings)})


@router.get("/backups/{backup_id}")
def get_backup(backup_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    path = settings.resolved_storage_root / "backups" / f"{backup_id}.zip"
    if not path.exists():
        return fail("备份不存在", status_code=404)
    backup = next((item for item in list_backup_archives(settings) if item["id"] == backup_id), None)
    return ok({"backup": backup or {"id": backup_id, "name": path.name, "sizeBytes": path.stat().st_size, "createdAt": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()}})


@router.post("/backups")
def create_backup(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    backup = create_backup_archive(db, settings)
    return ok({"backup": {"id": backup.id, "name": backup.filename, "filename": backup.filename, "sizeBytes": backup.size_bytes, "createdAt": backup.created_at, "counts": backup.counts}}, status_code=201)


@router.get("/backups/{backup_id}/download")
def download_backup(backup_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return _send_file(settings.resolved_storage_root / "backups" / f"{backup_id}.zip", request, user.id, media_type="application/zip", name=f"{backup_id}.zip", route="backup-download", file_id=backup_id)


@router.post("/backups/{backup_id}/restore")
def restore_backup(backup_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    path = settings.resolved_storage_root / "backups" / f"{backup_id}.zip"
    if not path.exists():
        return fail("备份不存在", status_code=404)
    try:
        result = restore_backup_archive(db, settings, backup_id)
    except ValueError as exc:
        return fail(str(exc), status_code=400)
    return ok(result)


@router.delete("/backups/{backup_id}")
def delete_backup(backup_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    path = settings.resolved_storage_root / "backups" / f"{backup_id}.zip"
    if path.exists():
        path.unlink()
        return ok({"deleted": True, "id": backup_id})
    return ok({"deleted": False, "id": backup_id})


def _metadata_context_for_work(db: Session, work_id: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    job = ensure_organize_job_for_work(db, work_id)
    if not job:
        return None, None
    return job, context_for_job(db, job)


def _metadata_field_patch(candidate: dict[str, Any], fields: list[str]) -> dict[str, Any]:
    patch: dict[str, Any] = {}
    selected = set(fields)
    if "title" in selected and isinstance(candidate.get("title"), str) and candidate.get("title").strip():
        patch["title"] = candidate["title"].strip()
        patch["normalizedTitle"] = normalize_key(candidate["title"])
    if "author" in selected and isinstance(candidate.get("author"), str):
        patch["author"] = candidate["author"].strip() or None
        patch["normalizedAuthor"] = normalize_key(candidate["author"]) or None
    if "description" in selected and isinstance(candidate.get("description"), str):
        patch["description"] = candidate["description"].strip() or None
    if "tags" in selected and isinstance(candidate.get("tags"), list):
        tags = sorted({str(tag).strip() for tag in candidate.get("tags") or [] if str(tag).strip()})
        patch["tags"] = _json_text(tags)
    if "seriesName" in selected and isinstance(candidate.get("seriesName"), str):
        patch["seriesName"] = candidate["seriesName"].strip() or None
    if "seriesIndex" in selected and candidate.get("seriesIndex") is not None:
        try:
            patch["seriesIndex"] = float(candidate["seriesIndex"])
        except (TypeError, ValueError):
            pass
    if "publishedYear" in selected and candidate.get("publishedYear") is not None:
        try:
            patch["publishedYear"] = int(candidate["publishedYear"])
        except (TypeError, ValueError):
            pass
    return patch


def _finish_metadata_organize_work(db: Session, work_id: str) -> list[str]:
    if not _has_table(db, "OrganizeJob"):
        return []
    jobs = _rows(
        db,
        "SELECT `id` FROM `OrganizeJob` WHERE `workId` = :work_id AND `status` IN ('PENDING', 'REVIEWING', 'FAILED')",
        {"work_id": work_id},
    )
    job_ids = [str(job["id"]) for job in jobs if job.get("id")]
    if not job_ids:
        return []
    for job_id in job_ids:
        _update(db, "OrganizeJob", job_id, {"status": "APPLIED", "summary": "元数据已应用，整理完成", "errorSummary": None, "updatedAt": _now()})
    placeholders = ", ".join(f":job_id_{index}" for index, _ in enumerate(job_ids))
    params = {f"job_id_{index}": job_id for index, job_id in enumerate(job_ids)}
    if _has_table(db, "MetadataSuggestion"):
        db.execute(text(f"UPDATE `MetadataSuggestion` SET `status` = 'DISMISSED' WHERE `jobId` IN ({placeholders}) AND `status` = 'PENDING'"), params)
    if _has_table(db, "DuplicateCandidate"):
        db.execute(text(f"UPDATE `DuplicateCandidate` SET `status` = 'DISMISSED' WHERE `jobId` IN ({placeholders}) AND `status` = 'PENDING'"), params)
    db.commit()
    return job_ids


def _apply_remote_cover(work_id: str, cover_url: str, settings: Settings) -> dict[str, Any]:
    if not cover_url.startswith(("http://", "https://")):
        return {}
    request = UrlRequest(cover_url, headers={"Accept": "image/*,*/*", "User-Agent": "Shuku Starship Python", "Referer": "https://book.douban.com/"})
    with urlopen(request, timeout=30) as response:
        content_type = response.headers.get("content-type") or ""
        data = response.read(8 * 1024 * 1024)
    suffix = ".jpg"
    if "png" in content_type:
        suffix = ".png"
    elif "webp" in content_type:
        suffix = ".webp"
    elif "." in cover_url.rsplit("/", 1)[-1].split("?", 1)[0]:
        suffix = Path(cover_url.rsplit("/", 1)[-1].split("?", 1)[0]).suffix[:12] or suffix
    target_dir = settings.resolved_storage_root / "covers"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{work_id}{suffix}"
    target.write_bytes(data)
    return {"coverPath": str(target.relative_to(settings.resolved_storage_root)), "coverStatus": "READY", "updatedAt": _now()}


@router.post("/works/{work_id}/metadata/search")
async def metadata_search(work_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    source = str(payload.get("source") or "bangumi")
    if source not in {"bangumi", "douban", "ai"}:
        return fail("不支持的元数据来源", status_code=400)
    job, context = _metadata_context_for_work(db, work_id)
    if not job or not context:
        return fail("读物不存在或无权访问", status_code=404)
    query = str(payload.get("query") or "").strip() or None
    try:
        result = metadata_search_candidates(db, context, source, query)
    except Exception as exc:
        return fail(str(exc), status_code=400)
    candidates = result.get("candidates") or []
    return ok({"candidates": candidates, "results": candidates, "query": query or context["work"].get("title"), "source": source, "message": result.get("message")})


@router.post("/works/{work_id}/metadata/apply")
@router.post("/works/{work_id}/metadata/refresh")
@router.post("/works/{work_id}/editions/{edition_id}/primary")
@router.post("/works/{work_id}/editions/{edition_id}/split")
@router.post("/works/{work_id}/volumes/{volume_id}/move")
async def compatible_work_action(work_id: str, request: Request, edition_id: str | None = None, volume_id: str | None = None, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    if request.url.path.endswith("/metadata/apply"):
        payload = await request.json()
        candidate = payload.get("candidate") if isinstance(payload.get("candidate"), dict) else {}
        fields = [str(field) for field in payload.get("fields") or []]
        if not candidate or not fields:
            return fail("请选择要应用的元数据字段", status_code=400)
        patch = _metadata_field_patch(candidate, fields)
        if "coverUrl" in fields and isinstance(candidate.get("coverUrl"), str) and candidate.get("coverUrl").strip():
            try:
                patch.update(_apply_remote_cover(work_id, candidate["coverUrl"].strip(), settings))
            except Exception as exc:
                logger.warning("failed to apply remote cover work=%s url=%s error=%s", work_id, candidate.get("coverUrl"), exc)
        if not patch:
            return fail("候选中没有可应用的字段", status_code=400)
        patch.update({"organized": True, "organizeStatus": "APPLIED", "metadataQuality": 85, "updatedAt": _now()})
        work = _update(db, "LibraryWork", work_id, patch)
        if not work:
            return fail("作品不存在", status_code=404)
        finished_job_ids = _finish_metadata_organize_work(db, work_id)
        return ok({"book": _work_view(db, work, user.id), "appliedFields": fields, "finishedOrganizeJobIds": finished_job_ids})
    if request.url.path.endswith("/metadata/refresh"):
        payload = await request.json()
        providers = [str(provider) for provider in payload.get("providers") or [] if str(provider) in {"external", "bangumi", "douban", "ai"}]
        if not providers:
            return fail("请选择要刷新的元数据来源", status_code=400)
        job = ensure_organize_job_for_work(db, work_id)
        if not job:
            return fail("读物不存在或无权访问", status_code=404)
        try:
            result = refresh_metadata_providers(db, job["id"], providers, force=True)
        except ValueError as exc:
            return fail(str(exc), status_code=404 if "不存在" in str(exc) else 400)
        disabled = all(not item.get("enabled") for item in result["results"])
        errors = [item.get("error") for item in result["results"] if item.get("error")]
        usable = any(item.get("enabled") and not item.get("error") for item in result["results"])
        disabled_messages = [item.get("message") for item in result["results"] if item.get("message")]
        message = (
            "；".join(disabled_messages) or "外部数据查询或 AI 识别尚未配置。"
            if disabled
            else f"元数据刷新失败：{'；'.join(errors)}"
            if not usable and errors
            else f"已刷新，新增 {result['added']} 条候选建议。"
        )
        return ok({"jobId": job["id"], **result, "enabled": usable, "message": message})
    if request.url.path.endswith("/primary") and edition_id:
        _update(db, "LibraryWork", work_id, {"primaryEditionId": edition_id})
        _update(db, "LibraryEdition", edition_id, {"primary": True})
    if request.url.path.endswith("/move") and volume_id:
        payload = await request.json()
        direction = str(payload.get("direction") or "").lower()
        if direction not in {"up", "down"}:
            return fail("请选择上移或下移", status_code=400)
        volume = _row(
            db,
            """
            SELECT v.* FROM `LibraryVolume` v
            JOIN `LibraryEdition` e ON e.`id` = v.`editionId`
            WHERE v.`id` = :volume_id AND e.`workId` = :work_id
            """,
            {"volume_id": volume_id, "work_id": work_id},
        ) if _has_table(db, "LibraryVolume") and _has_table(db, "LibraryEdition") else None
        if not volume:
            return fail("卷册不存在或不属于该作品", status_code=404)
        volumes = _rows(db, "SELECT * FROM `LibraryVolume` WHERE `editionId` = :edition_id ORDER BY `sortOrder` ASC, `id` ASC", {"edition_id": volume["editionId"]})
        index = next((item_index for item_index, item in enumerate(volumes) if item["id"] == volume_id), -1)
        target_index = index - 1 if direction == "up" else index + 1
        if index < 0 or target_index < 0 or target_index >= len(volumes):
            work = _get_work(db, work_id)
            return ok({"book": _work_view(db, work, user.id) if work else None, "workId": work_id, "volumeId": volume_id})
        target = volumes[target_index]
        _update(db, "LibraryVolume", volume_id, {"sortOrder": target.get("sortOrder") or 0, "updatedAt": _now()})
        _update(db, "LibraryVolume", target["id"], {"sortOrder": volume.get("sortOrder") or 0, "updatedAt": _now()})
        work = _get_work(db, work_id)
        return ok({"book": _work_view(db, work, user.id) if work else None, "workId": work_id, "volumeId": volume_id})
    work = _get_work(db, work_id)
    return ok({"book": _work_view(db, work, user.id) if work else None, "workId": work_id, "editionId": edition_id, "volumeId": volume_id})


@router.get("/tracking/release-title-parser")
def release_title_parser_get(request: Request, title: str = "", db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    volume_info = parse_series_volume_info(Path(f"{title}.epub"), f"{title}.epub", "MANUAL")
    chapter = re.search(r"(?:ch(?:apter)?\.?|第)\s*(\d+(?:\.\d+)?)\s*(?:话|章|ch)?", title, flags=re.IGNORECASE)
    return ok({"parsed": {"title": title, "volume": volume_info.series_index if volume_info else None, "chapter": float(chapter.group(1)) if chapter else None}})


@router.post("/tracking/release-title-parser")
async def release_title_parser(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    title = str(payload.get("title") or "")
    volume_info = parse_series_volume_info(Path(f"{title}.epub"), f"{title}.epub", "MANUAL")
    chapter = re.search(r"(?:ch(?:apter)?\.?|第)\s*(\d+(?:\.\d+)?)\s*(?:话|章|ch)?", title, flags=re.IGNORECASE)
    return ok({"parsed": {"title": title, "volume": volume_info.series_index if volume_info else None, "chapter": float(chapter.group(1)) if chapter else None}})
