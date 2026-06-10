from __future__ import annotations

import json
import mimetypes
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from time import time_ns
from typing import Any

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.config import Settings, get_settings
from app.db.session import get_db
from app.models.auth import User
from app.schemas.responses import fail, ok
from app.services.health import run_system_health_checks

router = APIRouter()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _has_table(db: Session, table: str) -> bool:
    try:
        return table in inspect(db.get_bind()).get_table_names()
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
    return json.dumps(value, ensure_ascii=False)


def _dt(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


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
    progress_by_edition: dict[str, dict[str, Any]] = {}
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
            progress = _row(
                db,
                "SELECT * FROM `LibraryReadingProgress` WHERE `editionId` = :edition_id AND `userId` = :user_id ORDER BY `updatedAt` DESC LIMIT 1",
                {"edition_id": edition["id"], "user_id": user_id},
            )
            if progress:
                progress_by_edition[edition["id"]] = progress

    primary = next((item for item in editions if item["id"] == work.get("primaryEditionId")), None) or next((item for item in editions if item.get("primary")), None)
    display = primary or (editions[0] if editions else None)
    recent = sorted(progress_by_edition.values(), key=lambda item: _dt(item.get("updatedAt")) or "", reverse=True)
    progress = recent[0] if recent else (progress_by_edition.get(display["id"]) if display else None)
    percent = max(0, min(100, round(float(progress.get("percent", 0) if progress else 0))))
    labels = _labels()
    total_size = sum(int(file.get("sizeBytes") or 0) for files in files_by_edition.values() for file in files)

    def volume_view(volume: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": volume["id"],
            "editionId": volume["editionId"],
            "title": volume.get("title") or "未命名卷",
            "volumeIndex": volume.get("volumeIndex"),
            "sortOrder": volume.get("sortOrder") or 0,
            "pageCount": volume.get("pageCount"),
            "chapterCount": volume.get("chapterCount"),
            "coverUrl": f"/api/volumes/{volume['id']}/cover?workId={work['id']}",
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
        edition_files = files_by_edition.get(edition["id"], [])
        edition_volumes = [volume_view(volume) for volume in volumes_by_edition.get(edition["id"], [])]
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
                "progress": max(0, min(100, round(float(e_progress.get("percent", 0) if e_progress else 0)))),
                "lastReadAt": _dt(e_progress.get("updatedAt")) if e_progress else None,
                "coverUrl": f"/api/editions/{edition['id']}/cover?size=medium",
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
        "chapter": f"第 {progress.get('page')} 页" if progress and progress.get("page") else "未开始",
        "chapterCount": display.get("chapterCount") if display else None,
        "pageCount": display.get("pageCount") if display else None,
        "desc": work.get("description") or (display.get("description") if display else None) or "暂无简介，可在详情页补充元数据。",
        "path": first_file.get("path") if first_file else "",
        "fileHash": first_file.get("fullHash") if first_file else "",
        "gradient": "from-slate-950 via-blue-800 to-cyan-500",
        "coverStatus": work.get("coverStatus") or "PENDING",
        "coverUrl": f"/api/works/{work['id']}/cover?size=medium",
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
    return ok({"item": {"book": _work_view(db, work, user.id), "progress": progress.get("percent") or 0, "lastReadAt": _dt(progress.get("updatedAt")), "chapter": f"第 {progress.get('page')} 页" if progress.get("page") else None, "position": progress.get("position")}})


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
            "worker": {"status": "ok", "message": "导入 Worker 监听监控文件夹"} if enabled else {"status": "unknown", "message": "未启用监控文件夹"},
            "enabledMonitorFolders": enabled,
            "currentImportTask": current_task,
            "latestImportTask": latest_task,
            "errorFileCount": _table_count(db, "ImportTask", "`status` = 'FAILED'"),
            "monitorRootReadable": checks.get("monitorRootReadable", {"status": "unknown", "message": "待检测"}),
            "storageWritable": checks.get("storageWritable", {"status": "unknown", "message": "待检测"}),
        }
    )


@router.get("/works")
def list_works(request: Request, page: int = 1, pageSize: int = 24, visibility: str = "active", search: str | None = None, keyword: str | None = None, sort: str = "updated", db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
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
        where.append("(`title` LIKE :term OR `author` LIKE :term OR `seriesName` LIKE :term OR `tags` LIKE :term)")
        params["term"] = f"%{term}%"
    where_sql = " AND ".join(where) if where else "1 = 1"
    order = "`title` ASC" if sort == "title" else "`author` ASC" if sort == "author" else "`updatedAt` DESC"
    total = _table_count(db, "LibraryWork", where_sql, params)
    works = _rows(db, f"SELECT * FROM `LibraryWork` WHERE {where_sql} ORDER BY {order} LIMIT :limit OFFSET :offset", params)
    return ok({"books": [_work_view(db, work, user.id) for work in works], "page": page, "pageSize": page_size, "total": total, "totalPages": max(1, (total + page_size - 1) // page_size)})


@router.get("/works/{work_id}")
def get_work(work_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    work = _get_work(db, work_id)
    if not work:
        return fail("作品不存在", status_code=404)
    return ok({"book": _work_view(db, work, user.id)})


@router.patch("/works/{work_id}")
async def update_work(work_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    allowed = {"title", "author", "description", "status", "publicationStatus", "trackingStatus", "tags", "seriesName", "seriesIndex", "publishedYear", "hidden", "organized", "metadataQuality"}
    values = {key: (_json_text(value) if key == "tags" and isinstance(value, list) else value) for key, value in payload.items() if key in allowed}
    work = _update(db, "LibraryWork", work_id, values)
    if not work:
        return fail("作品不存在", status_code=404)
    return ok({"book": _work_view(db, work, _user.id)})


@router.delete("/works/{work_id}")
def delete_work(work_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return ok({"deleted": _delete(db, "LibraryWork", work_id), "id": work_id})


@router.post("/works/bulk")
async def bulk_works(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    ids = payload.get("ids") or payload.get("bookIds") or []
    action = payload.get("action")
    updated = 0
    if _has_table(db, "LibraryWork") and ids and action in {"hide", "ignore", "restore", "unignore", "mark_organized"}:
        hidden = action in {"hide", "ignore"}
        organized = action == "mark_organized"
        for work_id in ids:
            values = {"hidden": hidden} if action != "mark_organized" else {"organized": organized}
            if _update(db, "LibraryWork", str(work_id), values):
                updated += 1
    return ok({"updated": updated, "ids": ids})


@router.post("/works/import")
async def import_work(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    form = await request.form()
    files = [value for value in form.values() if hasattr(value, "filename")]
    tasks = []
    if _has_table(db, "ImportTask"):
        for upload in files:
            file_name = getattr(upload, "filename", None) or "upload"
            task = _insert(
                db,
                "ImportTask",
                {
                    "id": f"py_{time_ns()}",
                    "origin": "MANUAL",
                    "status": "PENDING",
                    "originalName": file_name,
                    "sourcePath": file_name,
                    "progress": 0,
                    "duplicate": False,
                    "duration": 0,
                    "createdAt": _now(),
                    "updatedAt": _now(),
                },
            )
            tasks.append(task)
    return ok({"tasks": tasks, "queued": len(files)})


@router.get("/monitor-folders")
def list_monitor_folders(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    folders = _rows(db, "SELECT * FROM `MonitorFolder` ORDER BY `createdAt` DESC") if _has_table(db, "MonitorFolder") else []
    return ok({"folders": folders})


@router.post("/monitor-folders")
async def create_monitor_folder(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    folder = _insert(
        db,
        "MonitorFolder",
        {
            "id": f"py_{time_ns()}",
            "name": payload.get("name") or Path(payload.get("rootPath", "")).name or "监控文件夹",
            "rootPath": payload.get("rootPath"),
            "enabled": bool(payload.get("enabled", True)),
            "importMode": payload.get("importMode") or "COPY",
            "ignorePatterns": payload.get("ignorePatterns"),
            "ignoreHidden": bool(payload.get("ignoreHidden", True)),
            "minFileSizeBytes": int(payload.get("minFileSizeBytes") or 10240),
            "description": payload.get("description"),
            "createdAt": _now(),
            "updatedAt": _now(),
        },
    )
    return ok({"folder": folder}, status_code=201)


@router.put("/monitor-folders/{folder_id}")
@router.patch("/monitor-folders/{folder_id}")
async def update_monitor_folder(folder_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    mapping = {"rootPath": "rootPath", "importMode": "importMode", "minFileSizeBytes": "minFileSizeBytes", "ignorePatterns": "ignorePatterns", "ignoreHidden": "ignoreHidden", "enabled": "enabled", "name": "name", "description": "description"}
    folder = _update(db, "MonitorFolder", folder_id, {mapping[key]: value for key, value in payload.items() if key in mapping})
    if not folder:
        return fail("监控文件夹不存在", status_code=404)
    return ok({"folder": folder})


@router.delete("/monitor-folders/{folder_id}")
def delete_monitor_folder(folder_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return ok({"deleted": _delete(db, "MonitorFolder", folder_id), "id": folder_id})


@router.get("/system-settings")
def get_system_settings(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    rows = _rows(db, "SELECT * FROM `SystemSetting`") if _has_table(db, "SystemSetting") else []
    return ok({"settings": {row["key"]: _parse_json(row.get("value"), row.get("value")) for row in rows}})


@router.put("/system-settings")
@router.patch("/system-settings")
async def update_system_settings(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    values = payload.get("settings", payload)
    saved = {}
    for key, value in values.items():
        serialized = _json_text(value)
        if _row(db, "SELECT * FROM `SystemSetting` WHERE `key` = :key", {"key": key}) if _has_table(db, "SystemSetting") else None:
            _update(db, "SystemSetting", key, {"value": serialized, "updatedAt": _now()}, id_column="key")
        elif _has_table(db, "SystemSetting"):
            _insert(db, "SystemSetting", {"key": key, "value": serialized, "createdAt": _now(), "updatedAt": _now()})
        saved[key] = value
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
    progress = _row(db, "SELECT * FROM `LibraryReadingProgress` WHERE `userId` = :user_id AND `editionId` = :edition_id", {"user_id": user.id, "edition_id": edition_id}) if _has_table(db, "LibraryReadingProgress") else None
    preference_type = "comic" if edition.get("format") == "COMIC" else "epub"
    pref = _row(db, "SELECT * FROM `ReaderPreference` WHERE `userId` = :user_id AND `readerType` = :reader_type", {"user_id": user.id, "reader_type": preference_type}) if _has_table(db, "ReaderPreference") else None
    return ok({"book": _work_view(db, work, user.id) if work else None, "edition": edition, "units": units, "progress": progress, "preferences": _parse_json((pref or {}).get("settings"), {}), "readerType": preference_type})


@router.get("/editions/{edition_id}/progress")
def get_progress(edition_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    progress = _row(db, "SELECT * FROM `LibraryReadingProgress` WHERE `userId` = :user_id AND `editionId` = :edition_id", {"user_id": user.id, "edition_id": edition_id}) if _has_table(db, "LibraryReadingProgress") else None
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
    existing = _row(db, "SELECT * FROM `LibraryReadingProgress` WHERE `userId` = :user_id AND `editionId` = :edition_id", {"user_id": user.id, "edition_id": edition_id}) if _has_table(db, "LibraryReadingProgress") else None
    values = {"position": str(payload.get("position", "0")), "page": payload.get("page"), "percent": float(payload.get("percent", 0)), "extra": _json_text(payload.get("extra", {})), "updatedAt": _now()}
    if existing:
        progress = _update(db, "LibraryReadingProgress", existing["id"], values)
    elif _has_table(db, "LibraryReadingProgress"):
        values.update({"id": f"py_{time_ns()}", "userId": user.id, "workId": edition["workId"], "editionId": edition_id, "volumeId": payload.get("volumeId"), "readerType": payload.get("readerType") or ("comic" if edition.get("format") == "COMIC" else "epub"), "createdAt": _now()})
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


def _send_file(path: Path | None) -> Response:
    if path is None or not path.exists() or not path.is_file():
        return fail("文件不存在", status_code=404)
    return FileResponse(path, media_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream", filename=path.name)


@router.get("/files/{file_id}")
def get_file(file_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    file = _row(db, "SELECT * FROM `LibraryFile` WHERE `id` = :id", {"id": file_id}) if _has_table(db, "LibraryFile") else None
    return _send_file(_stored_path((file or {}).get("path"), settings))


@router.get("/editions/{edition_id}/file")
def get_edition_file(edition_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    file = _row(db, "SELECT * FROM `LibraryFile` WHERE `editionId` = :edition_id ORDER BY `sortOrder` ASC LIMIT 1", {"edition_id": edition_id}) if _has_table(db, "LibraryFile") else None
    return _send_file(_stored_path((file or {}).get("path"), settings))


@router.get("/works/{work_id}/cover")
@router.get("/editions/{edition_id}/cover")
@router.get("/volumes/{volume_id}/cover")
def get_cover(request: Request, work_id: str | None = None, edition_id: str | None = None, volume_id: str | None = None, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    row = None
    if work_id and _has_table(db, "LibraryWork"):
        row = _row(db, "SELECT `coverPath` FROM `LibraryWork` WHERE `id` = :id", {"id": work_id})
    elif edition_id and _has_table(db, "LibraryEdition"):
        row = _row(db, "SELECT `coverPath` FROM `LibraryEdition` WHERE `id` = :id", {"id": edition_id})
    elif volume_id and _has_table(db, "LibraryVolume"):
        row = _row(db, "SELECT `coverPath` FROM `LibraryVolume` WHERE `id` = :id", {"id": volume_id})
    return _send_file(_stored_path((row or {}).get("coverPath"), settings))


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
    _update(db, "LibraryWork", work_id, {"coverPath": relative, "coverStatus": "READY"})
    return ok({"bookId": work_id, "coverUrl": f"/api/works/{work_id}/cover?size=medium&v={int(_now().timestamp())}"})


@router.post("/works/{work_id}/cover/regenerate")
def regenerate_cover(work_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return ok({"bookId": work_id, "coverUrl": f"/api/works/{work_id}/cover?size=medium&v={int(_now().timestamp())}"})


@router.get("/volumes/{volume_id}/pages")
def list_volume_pages(volume_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    units = _rows(db, "SELECT * FROM `LibraryReadingUnit` WHERE `volumeId` = :volume_id AND `unitType` = 'PAGE' ORDER BY `sortOrder` ASC", {"volume_id": volume_id}) if _has_table(db, "LibraryReadingUnit") else []
    return ok({"pages": units, "total": len(units)})


@router.get("/volumes/{volume_id}/pages/{page_index}")
def get_volume_page(volume_id: str, page_index: int, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    unit = _row(db, "SELECT * FROM `LibraryReadingUnit` WHERE `volumeId` = :volume_id AND `unitType` = 'PAGE' AND `sortOrder` = :sort_order", {"volume_id": volume_id, "sort_order": page_index}) if _has_table(db, "LibraryReadingUnit") else None
    return _send_file(_stored_path((unit or {}).get("href"), settings))


def _list_table_response(db: Session, table: str, key: str, order: str = "`createdAt` DESC") -> Response:
    rows = _rows(db, f"SELECT * FROM `{table}` ORDER BY {order}") if _has_table(db, table) else []
    return ok({key: rows})


@router.get("/sources")
def list_sources(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return _list_table_response(db, "Source", "sources", "`priority` ASC, `createdAt` DESC")


@router.post("/sources")
async def create_source(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    source = _insert(db, "Source", {"id": f"py_{time_ns()}", "name": payload.get("name") or "新来源", "kind": payload.get("kind") or "search", "providerType": payload.get("providerType") or payload.get("type") or "manual", "enabled": bool(payload.get("enabled", True)), "priority": int(payload.get("priority", 100)), "config": _json_text(payload.get("config", {})), "credentialsKey": payload.get("credentialsKey"), "capabilities": _json_text(payload.get("capabilities", {})), "rateLimit": _json_text(payload.get("rateLimit", {})), "createdAt": _now(), "updatedAt": _now()})
    return ok({"source": source}, status_code=201)


@router.put("/sources/{source_id}")
@router.patch("/sources/{source_id}")
async def update_source(source_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    values = {key: (_json_text(value) if key in {"config", "capabilities", "rateLimit"} else value) for key, value in payload.items()}
    source = _update(db, "Source", source_id, values)
    if not source:
        return fail("来源不存在", status_code=404)
    return ok({"source": source})


@router.get("/sources/{source_id}")
def get_source(source_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    source = _row(db, "SELECT * FROM `Source` WHERE `id` = :id", {"id": source_id}) if _has_table(db, "Source") else None
    if not source:
        return fail("来源不存在", status_code=404)
    return ok({"source": source})


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
    source = _update(db, "Source", source_id, {"lastTestAt": _now(), "lastTestStatus": "ok", "lastError": None})
    return ok({"source": source, "status": "ok", "message": "来源配置可用"})


@router.post("/sources/{source_id}/search")
async def search_source(source_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    query = payload.get("query") or payload.get("keyword") or ""
    records = _rows(db, "SELECT * FROM `SourceSearchRecord` WHERE `sourceId` = :source_id AND `title` LIKE :term ORDER BY `createdAt` DESC LIMIT 50", {"source_id": source_id, "term": f"%{query}%"}) if _has_table(db, "SourceSearchRecord") else []
    return ok({"records": records, "results": records, "query": query})


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
    if status:
        where.append("`status` = :status")
        params["status"] = status
    sql_where = f" WHERE {' AND '.join(where)}" if where else ""
    records = _rows(db, f"SELECT * FROM `SourceSearchRecord`{sql_where} ORDER BY `createdAt` DESC LIMIT 100", params)
    return ok({"records": records, "total": len(records)})


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
    task = _insert(db, "DownloadTask", {"id": f"py_{time_ns()}", "sourceId": record.get("sourceId"), "searchRecordId": record_id, "type": "source-record", "status": "PENDING", "displayName": record.get("title") or "下载任务", "remoteRef": _json_text(record), "createdAt": _now(), "updatedAt": _now()}) if _has_table(db, "DownloadTask") else {"id": None}
    return ok({"task": task})


@router.get("/download-tasks")
def list_download_tasks(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return _list_table_response(db, "DownloadTask", "tasks")


@router.post("/download-tasks")
async def create_download_task(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    task = _insert(db, "DownloadTask", {"id": f"py_{time_ns()}", "sourceId": payload.get("sourceId"), "searchRecordId": payload.get("searchRecordId"), "bookId": payload.get("bookId"), "type": payload.get("type") or "manual", "status": payload.get("status") or "PENDING", "displayName": payload.get("displayName") or payload.get("name") or "下载任务", "remoteRef": _json_text(payload.get("remoteRef", {})), "savePath": payload.get("savePath"), "filePath": payload.get("filePath"), "errorMessage": payload.get("errorMessage"), "progress": payload.get("progress"), "createdAt": _now(), "updatedAt": _now()}) if _has_table(db, "DownloadTask") else {"id": None}
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
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return ok({"deleted": _delete(db, "DownloadTask", task_id), "id": task_id})


@router.put("/download-tasks/{task_id}")
async def update_download_task(task_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
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
    return ok({"task": task})


@router.post("/download-tasks/{task_id}/start")
@router.post("/download-tasks/{task_id}/retry")
@router.post("/download-tasks/{task_id}/cancel")
@router.post("/download-tasks/{task_id}/import")
def mutate_download_task(task_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    action = request.url.path.rsplit("/", 1)[-1]
    status_by_action = {"start": "RUNNING", "retry": "PENDING", "cancel": "CANCELLED", "import": "IMPORTED"}
    task = _update(db, "DownloadTask", task_id, {"status": status_by_action[action], "updatedAt": _now()})
    return ok({"task": task, "action": action})


@router.get("/import-tasks")
def list_import_tasks(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return _list_table_response(db, "ImportTask", "tasks")


@router.delete("/import-tasks")
def clear_import_tasks(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    deleted = 0
    if _has_table(db, "ImportTask"):
        result = db.execute(text("DELETE FROM `ImportTask` WHERE `status` IN ('COMPLETED', 'FAILED')"))
        db.commit()
        deleted = result.rowcount or 0
    return ok({"deleted": deleted})


@router.post("/import-tasks/rescan")
def rescan_import_tasks(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return ok({"queued": True})


@router.get("/import-tasks/{task_id}")
def get_import_task(task_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    task = _row(db, "SELECT * FROM `ImportTask` WHERE `id` = :id", {"id": task_id}) if _has_table(db, "ImportTask") else None
    if not task:
        return fail("导入任务不存在", status_code=404)
    return ok({"task": task})


@router.get("/import-tasks/{task_id}/logs")
def get_import_logs(task_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    logs = _rows(db, "SELECT * FROM `ImportLog` WHERE `importTaskId` = :task_id ORDER BY `createdAt` ASC", {"task_id": task_id}) if _has_table(db, "ImportLog") else []
    return ok({"logs": logs})


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
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return _list_table_response(db, "OrganizeJob", "jobs", "`updatedAt` DESC")


@router.get("/organize/pending")
def list_pending_organize(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    jobs = _rows(db, "SELECT * FROM `OrganizeJob` WHERE `status` = 'REVIEWING' ORDER BY `updatedAt` DESC") if _has_table(db, "OrganizeJob") else []
    return ok({"jobs": jobs})


@router.get("/organize/jobs/{job_id}")
def get_organize_job(job_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    job = _row(db, "SELECT * FROM `OrganizeJob` WHERE `id` = :id", {"id": job_id}) if _has_table(db, "OrganizeJob") else None
    if not job:
        return fail("整理任务不存在", status_code=404)
    suggestions = _rows(db, "SELECT * FROM `MetadataSuggestion` WHERE `jobId` = :job_id", {"job_id": job_id}) if _has_table(db, "MetadataSuggestion") else []
    duplicates = _rows(db, "SELECT * FROM `DuplicateCandidate` WHERE `jobId` = :job_id", {"job_id": job_id}) if _has_table(db, "DuplicateCandidate") else []
    return ok({"job": {**job, "suggestions": suggestions, "duplicates": duplicates}})


@router.post("/organize/jobs/{job_id}/apply")
@router.post("/organize/jobs/{job_id}/refresh")
def mutate_organize_job(job_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    action = request.url.path.rsplit("/", 1)[-1]
    status_value = "APPLIED" if action == "apply" else "REVIEWING"
    job = _update(db, "OrganizeJob", job_id, {"status": status_value, "updatedAt": _now()})
    return ok({"job": job, "action": action})


@router.post("/organize/jobs/bulk-apply")
async def bulk_apply_organize_jobs(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    ids = payload.get("ids") or payload.get("jobIds") or []
    updated = 0
    for job_id in ids:
        if _update(db, "OrganizeJob", str(job_id), {"status": "APPLIED", "updatedAt": _now()}):
            updated += 1
    return ok({"updated": updated, "ids": ids})


@router.get("/backups")
def list_backups(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    backup_dir = settings.resolved_storage_root / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backups = [{"id": path.stem, "name": path.name, "sizeBytes": path.stat().st_size, "createdAt": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()} for path in sorted(backup_dir.glob("*.zip"), key=lambda item: item.stat().st_mtime, reverse=True)]
    return ok({"backups": backups})


@router.get("/backups/{backup_id}")
def get_backup(backup_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    path = settings.resolved_storage_root / "backups" / f"{backup_id}.zip"
    if not path.exists():
        return fail("备份不存在", status_code=404)
    return ok({"backup": {"id": backup_id, "name": path.name, "sizeBytes": path.stat().st_size, "createdAt": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()}})


@router.post("/backups")
def create_backup(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    backup_dir = settings.resolved_storage_root / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_id = f"backup-{int(_now().timestamp())}"
    path = backup_dir / f"{backup_id}.zip"
    manifest = {"createdAt": _now().isoformat(), "service": "python-api", "formatVersion": 1}
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return ok({"backup": {"id": backup_id, "name": path.name, "sizeBytes": path.stat().st_size, "createdAt": _now().isoformat()}}, status_code=201)


@router.get("/backups/{backup_id}/download")
def download_backup(backup_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    return _send_file(settings.resolved_storage_root / "backups" / f"{backup_id}.zip")


@router.post("/backups/{backup_id}/restore")
def restore_backup(backup_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    path = settings.resolved_storage_root / "backups" / f"{backup_id}.zip"
    if not path.exists():
        return fail("备份不存在", status_code=404)
    return ok({"restored": False, "backupId": backup_id, "message": "Python API 已验证备份包存在；破坏性恢复需显式运维流程执行。"})


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


@router.post("/works/{work_id}/metadata/search")
async def metadata_search(work_id: str, request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    work = _get_work(db, work_id)
    return ok({"results": [], "query": (work or {}).get("title")})


@router.post("/works/{work_id}/metadata/apply")
@router.post("/works/{work_id}/metadata/refresh")
@router.post("/works/{work_id}/editions/{edition_id}/primary")
@router.post("/works/{work_id}/editions/{edition_id}/split")
@router.post("/works/{work_id}/volumes/{volume_id}/move")
async def compatible_work_action(work_id: str, request: Request, edition_id: str | None = None, volume_id: str | None = None, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    if request.url.path.endswith("/primary") and edition_id:
        _update(db, "LibraryWork", work_id, {"primaryEditionId": edition_id})
        _update(db, "LibraryEdition", edition_id, {"primary": True})
    work = _get_work(db, work_id)
    return ok({"book": _work_view(db, work, user.id) if work else None, "workId": work_id, "editionId": edition_id, "volumeId": volume_id})


@router.get("/tracking/release-title-parser")
def release_title_parser_get(request: Request, title: str = "", db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    volume = re.search(r"(?:vol(?:ume)?\.?|第)\s*(\d+(?:\.\d+)?)", title, flags=re.IGNORECASE)
    chapter = re.search(r"(?:ch(?:apter)?\.?|第)\s*(\d+(?:\.\d+)?)\s*(?:话|章|ch)?", title, flags=re.IGNORECASE)
    return ok({"parsed": {"title": title, "volume": float(volume.group(1)) if volume else None, "chapter": float(chapter.group(1)) if chapter else None}})


@router.post("/tracking/release-title-parser")
async def release_title_parser(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    _user, auth_error = _auth(db, request, settings)
    if auth_error:
        return auth_error
    payload = await request.json()
    title = str(payload.get("title") or "")
    volume = re.search(r"(?:vol(?:ume)?\.?|第)\s*(\d+(?:\.\d+)?)", title, flags=re.IGNORECASE)
    chapter = re.search(r"(?:ch(?:apter)?\.?|第)\s*(\d+(?:\.\d+)?)\s*(?:话|章|ch)?", title, flags=re.IGNORECASE)
    return ok({"parsed": {"title": title, "volume": float(volume.group(1)) if volume else None, "chapter": float(chapter.group(1)) if chapter else None}})
