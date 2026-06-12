from __future__ import annotations

import json
import re
import shutil
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from time import time_ns
from typing import Any
from urllib.parse import unquote, urlparse
from urllib.parse import urljoin
from urllib.parse import urlencode
from urllib.request import Request as UrlRequest
from urllib.request import urlopen

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.services.zlibrary_eapi import USER_AGENT, login_with_config
from app.worker.importer import ImportOptions, import_managed_book


ALLOWED_EXTENSIONS = {".epub", ".txt", ".pdf", ".cbz", ".zip", ".rar", ".7z", ".torrent"}
BLOCKED_EXTENSIONS = {".exe", ".sh", ".bat", ".cmd", ".js", ".php", ".msi", ".com", ".scr", ".ps1", ".vbs"}
ACTIVE_DOWNLOAD_STATUSES = {"queued", "downloading", "downloaded", "importing", "completed"}
SUPPORTED_IMPORT_EXTENSIONS = {".epub", ".cbz", ".zip", ".pdf"}


@dataclass(frozen=True)
class DownloadExecutionResult:
    task: dict[str, Any]
    import_result: Any = None


@dataclass(frozen=True)
class QbittorrentConfig:
    url: str | None = None
    username: str | None = None
    password: str | None = None
    category: str | None = None
    save_path: str | None = None


def now() -> datetime:
    return datetime.now(timezone.utc)


def has_table(db: Session, table: str) -> bool:
    return table in inspect(db.get_bind()).get_table_names()


def row(db: Session, sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
    result = db.execute(text(sql), params or {}).mappings().first()
    return dict(result) if result else None


def rows(db: Session, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    return [dict(item) for item in db.execute(text(sql), params or {}).mappings().all()]


def update_row(db: Session, table: str, row_id: str, values: dict[str, Any]) -> dict[str, Any] | None:
    columns = {column["name"] for column in inspect(db.get_bind()).get_columns(table)}
    values = {key: value for key, value in values.items() if key in columns}
    if values:
        params = {**values, "row_id": row_id}
        assignments = ", ".join(f"`{key}` = :{key}" for key in values)
        db.execute(text(f"UPDATE `{table}` SET {assignments} WHERE `id` = :row_id"), params)
        db.commit()
    return row(db, f"SELECT * FROM `{table}` WHERE `id` = :id", {"id": row_id})


def remote_ref(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def string_value(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def system_setting(db: Session, key: str) -> str | None:
    if not has_table(db, "SystemSetting"):
        return None
    item = row(db, "SELECT `value` FROM `SystemSetting` WHERE `key` = :key", {"key": key})
    value = (item or {}).get("value")
    if value is None:
        return None
    try:
        parsed = json.loads(str(value))
    except json.JSONDecodeError:
        parsed = value
    return string_value(parsed) or None


def qbittorrent_config(db: Session, settings: Settings) -> QbittorrentConfig:
    return QbittorrentConfig(
        url=system_setting(db, "download.qbittorrent.url") or settings.qbittorrent_url,
        username=system_setting(db, "download.qbittorrent.username") or settings.qbittorrent_username,
        password=system_setting(db, "download.qbittorrent.password") or settings.qbittorrent_password,
        category=system_setting(db, "download.qbittorrent.category") or settings.qbittorrent_category,
        save_path=system_setting(db, "download.qbittorrent.savePath") or settings.qbittorrent_save_path,
    )


def infer_download_task_type(provider_type: str, download_meta: Any) -> str:
    meta = remote_ref(download_meta)
    if provider_type == "zlibrary" and meta.get("type") == "zlibrary_eapi":
        return "zlibrary"
    if string_value(meta.get("downloadUrl")):
        return "http"
    if provider_type in {"pt_rss", "torrent"}:
        return "blackhole" if meta.get("type") == "blackhole" or meta.get("kind") == "blackhole" or string_value(meta.get("blackholePath")) else "torrent"
    if provider_type in {"http", "rss", "comic_api", "zlibrary"}:
        return "http"
    return "manual"


def has_usable_download_meta(provider_type: str, download_meta: Any) -> bool:
    meta = remote_ref(download_meta)
    if provider_type == "zlibrary" and meta.get("type") == "zlibrary_eapi" and string_value(meta.get("zlibraryBookId")) and string_value(meta.get("zlibraryBookHash")):
        return True
    if string_value(meta.get("downloadUrl")):
        return True
    if provider_type == "pt_rss" and (string_value(meta.get("magnetUrl")) or string_value(meta.get("torrentUrl")) or string_value(meta.get("blackholePath"))):
        return True
    return False


def create_remote_ref_from_search_record(record: dict[str, Any]) -> dict[str, Any]:
    download_meta = remote_ref(record.get("downloadMeta"))
    return {
        "providerType": record.get("providerType"),
        "externalId": record.get("externalId"),
        "externalUrl": record.get("externalUrl"),
        "format": record.get("format"),
        "size": record.get("size"),
        "downloadMeta": download_meta,
        **download_meta,
    }


def sanitize_filename(value: str) -> str:
    base = unicodedata.normalize("NFKC", Path(value).name)
    base = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "_", base)
    base = re.sub(r"^\.+", "", base)
    base = re.sub(r"\s+", " ", base).strip()
    return base[:180] or "download"


def assert_allowed_extension(filename: str) -> None:
    ext = Path(filename).suffix.lower()
    if not ext:
        raise ValueError("下载文件缺少扩展名")
    if ext in BLOCKED_EXTENSIONS or ext not in ALLOWED_EXTENSIONS:
        raise ValueError(f"不允许下载 {ext[1:]} 文件")


def filename_from_content_disposition(header: str | None) -> str:
    if not header:
        return ""
    utf8_match = re.search(r"filename\*\s*=\s*UTF-8''([^;]+)", header, re.I)
    if utf8_match:
        return unquote(utf8_match.group(1).strip('"'))
    plain_match = re.search(r'filename\s*=\s*("?)([^";]+)\1', header, re.I)
    return plain_match.group(2) if plain_match else ""


def filename_from_url(value: str) -> str:
    parsed = urlparse(value)
    return unquote(Path(parsed.path).name) if parsed.path else ""


def unique_inbox_path(settings: Settings, filename: str) -> Path:
    inbox = settings.resolved_download_inbox_path
    inbox.mkdir(parents=True, exist_ok=True)
    sanitized = sanitize_filename(filename)
    parsed = Path(sanitized)
    stem = sanitize_filename(parsed.stem) or "download"
    suffix = parsed.suffix
    index = 0
    while True:
        candidate = inbox / f"{stem}{suffix}" if index == 0 else inbox / f"{stem}-{index}{suffix}"
        resolved = candidate.resolve()
        if inbox != resolved and inbox not in resolved.parents:
            raise ValueError("下载路径越界")
        if not resolved.exists():
            return resolved
        index += 1


def execute_http_download(db: Session, settings: Settings, task: dict[str, Any]) -> Path:
    ref = remote_ref(task.get("remoteRef"))
    download_url = string_value(ref.get("downloadUrl"))
    if not download_url:
        raise ValueError("下载任务缺少下载地址")
    parsed = urlparse(download_url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("只允许 http/https 下载地址")

    request = UrlRequest(download_url, headers={"Accept": "*/*"})
    with urlopen(request, timeout=30) as response:
        filename = sanitize_filename(
            filename_from_content_disposition(response.headers.get("content-disposition"))
            or string_value(ref.get("filename"))
            or filename_from_url(response.geturl() or download_url)
            or string_value(task.get("displayName"))
        )
        assert_allowed_extension(filename)
        target_path = unique_inbox_path(settings, filename)
        try:
            with target_path.open("xb") as handle:
                shutil.copyfileobj(response, handle)
            if target_path.stat().st_size <= 0:
                raise ValueError("下载文件为空")
            return target_path
        except Exception:
            target_path.unlink(missing_ok=True)
            raise


def execute_blackhole(settings: Settings, task: dict[str, Any]) -> Path:
    filename = sanitize_filename(f"{task.get('displayName') or task.get('id')}.txt")
    target_path = unique_inbox_path(settings, filename)
    note = "\n".join(
        [
            "Blackhole download placeholder",
            f"Task: {task.get('id')}",
            f"Title: {task.get('displayName')}",
            f"Created: {now().isoformat()}",
            "",
            "This task type is a placeholder. No external BT client was invoked.",
        ]
    )
    target_path.write_text(note, encoding="utf-8")
    return target_path


def qbittorrent_endpoint(config: QbittorrentConfig, path: str) -> str:
    base = string_value(config.url)
    if not base:
        raise ValueError("qBittorrent URL 未配置")
    return f"{base.rstrip('/')}/{path.lstrip('/')}"


def qbittorrent_request(config: QbittorrentConfig, path: str, payload: dict[str, str], cookie: str | None = None) -> tuple[int, str, str | None]:
    data = urlencode(payload).encode("utf-8")
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    if cookie:
        headers["Cookie"] = cookie
    request = UrlRequest(qbittorrent_endpoint(config, path), data=data, headers=headers, method="POST")
    with urlopen(request, timeout=30) as response:
        body = response.read().decode("utf-8", "replace")
        return response.status, body, response.headers.get("set-cookie")


def qbittorrent_cookie(config: QbittorrentConfig) -> str | None:
    username = string_value(config.username)
    password = string_value(config.password)
    if not username and not password:
        return None
    status, body, cookie = qbittorrent_request(config, "/api/v2/auth/login", {"username": username, "password": password})
    if status != 200 or body.strip().lower() not in {"ok", "ok.", ""}:
        raise ValueError("qBittorrent 登录失败")
    return cookie


def execute_qbittorrent_task(settings: Settings, config: QbittorrentConfig, task: dict[str, Any], torrent_ref: str, ref_type: str) -> Path:
    cookie = qbittorrent_cookie(config)
    payload = {"urls": torrent_ref, "paused": "false"}
    category = string_value(config.category)
    save_path = string_value(config.save_path)
    if category:
        payload["category"] = category
    if save_path:
        payload["savepath"] = save_path
    status, body, _cookie = qbittorrent_request(config, "/api/v2/torrents/add", payload, cookie)
    if status < 200 or status >= 300 or body.strip().lower() in {"fails.", "fail"}:
        raise ValueError(f"qBittorrent 提交失败：{body.strip() or status}")
    filename = ensure_suffix(string_value(task.get("displayName")) or string_value(task.get("id")) or "torrent", ".qbittorrent.json")
    target_path = unique_inbox_path(settings, filename)
    target_path.write_text(
        json.dumps(
            {
                "type": "qbittorrent_submission",
                "taskId": task.get("id"),
                "title": task.get("displayName"),
                "refType": ref_type,
                "ref": torrent_ref,
                "category": category or None,
                "savePath": save_path or None,
                "expectedName": string_value(task.get("displayName")) or None,
                "submittedAt": now().isoformat(),
                "message": "任务已提交到 qBittorrent。下载完成后请从客户端保存目录导入成品文件。",
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return target_path


def ensure_suffix(filename: str, suffix: str) -> str:
    return filename if Path(filename).suffix.lower() == suffix else f"{filename}{suffix}"


def execute_torrent_task(db: Session, settings: Settings, task: dict[str, Any]) -> Path:
    ref = remote_ref(task.get("remoteRef"))
    qbit = qbittorrent_config(db, settings)
    torrent_url = string_value(ref.get("torrentUrl"))
    if torrent_url:
        if string_value(qbit.url):
            return execute_qbittorrent_task(settings, qbit, task, torrent_url, "torrentUrl")
        return execute_http_download(db, settings, {**task, "remoteRef": {**ref, "downloadUrl": torrent_url, "filename": ensure_suffix(string_value(ref.get("filename")) or string_value(task.get("displayName")) or "download", ".torrent")}})

    magnet_url = string_value(ref.get("magnetUrl"))
    if magnet_url:
        if not magnet_url.startswith("magnet:?"):
            raise ValueError("magnetUrl 格式不正确")
        if string_value(qbit.url):
            return execute_qbittorrent_task(settings, qbit, task, magnet_url, "magnetUrl")
        filename = ensure_suffix(string_value(ref.get("filename")) or string_value(task.get("displayName")) or string_value(ref.get("externalId")) or str(task.get("id") or "torrent"), ".magnet")
        target_path = unique_inbox_path(settings, filename)
        target_path.write_text(magnet_url, encoding="utf-8")
        return target_path

    blackhole_path = string_value(ref.get("blackholePath"))
    if blackhole_path:
        return execute_blackhole(settings, task)
    raise ValueError("torrent 下载任务缺少 torrentUrl、magnetUrl 或 blackholePath")


def source_config(db: Session, source_id: str) -> dict[str, Any]:
    source = row(db, "SELECT `config` FROM `Source` WHERE `id` = :id", {"id": source_id}) if has_table(db, "Source") else None
    if not source:
        raise ValueError("Z-Library 下载任务缺少对应源配置")
    raw_config = source.get("config")
    if isinstance(raw_config, dict):
        return raw_config
    if isinstance(raw_config, str) and raw_config.strip():
        try:
            parsed = json.loads(raw_config)
        except json.JSONDecodeError as exc:
            raise ValueError("Z-Library 源配置不是有效 JSON") from exc
        if isinstance(parsed, dict):
            return parsed
    return {}


def execute_zlibrary_task(db: Session, settings: Settings, task: dict[str, Any]) -> Path:
    ref = remote_ref(task.get("remoteRef"))
    book_id = string_value(ref.get("zlibraryBookId"))
    book_hash = string_value(ref.get("zlibraryBookHash"))
    if not book_id or not book_hash:
        raise ValueError("Z-Library 下载任务缺少 zlibraryBookId/zlibraryBookHash")

    config = source_config(db, string_value(task.get("sourceId")))
    if string_value(ref.get("baseUrl")) and not string_value(config.get("baseUrl")):
        config = {**config, "baseUrl": string_value(ref.get("baseUrl"))}
    client, session = login_with_config(config)
    file_data = client.get_download_link(session, book_id, book_hash)
    download_url = string_value(file_data.get("downloadLink"))
    if not download_url:
        raise ValueError("Z-Library 下载链接为空")
    if download_url.startswith("/"):
        download_url = urljoin(f"{session.base_url}/", download_url.lstrip("/"))
    parsed = urlparse(download_url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Z-Library 下载链接不是 http/https URL")

    headers = {"Accept": "*/*", "User-Agent": USER_AGENT, "Cookie": session.cookie}
    referer = string_value(ref.get("href")) or string_value(ref.get("externalUrl"))
    if referer:
        headers["Referer"] = referer
    request = UrlRequest(download_url, headers=headers)
    with urlopen(request, timeout=60) as response:
        content_type = (response.headers.get("content-type") or "").lower()
        if "text/html" in content_type:
            raise ValueError("Z-Library 返回了 HTML 页面，可能是下载额度不足、登录失效或浏览器校验页。")
        filename = sanitize_filename(
            filename_from_content_disposition(response.headers.get("content-disposition"))
            or string_value(ref.get("filename"))
            or filename_from_url(response.geturl() or download_url)
            or string_value(task.get("displayName"))
        )
        assert_allowed_extension(filename)
        target_path = unique_inbox_path(settings, filename)
        try:
            with target_path.open("xb") as handle:
                shutil.copyfileobj(response, handle)
            if target_path.stat().st_size <= 0:
                raise ValueError("下载文件为空")
            return target_path
        except Exception:
            target_path.unlink(missing_ok=True)
            raise


def run_task(db: Session, settings: Settings, task: dict[str, Any]) -> Path:
    task_type = task.get("type")
    if task_type == "http":
        return execute_http_download(db, settings, task)
    if task_type == "blackhole":
        return execute_blackhole(settings, task)
    if task_type == "torrent":
        return execute_torrent_task(db, settings, task)
    if task_type == "zlibrary":
        return execute_zlibrary_task(db, settings, task)
    raise ValueError(f"下载类型 {task_type} 暂未支持")


def error_summary(error: Exception) -> str:
    return str(error or "下载执行失败")[:500]


def execute_download_task(db: Session, settings: Settings, task_id: str) -> DownloadExecutionResult:
    task = row(db, "SELECT * FROM `DownloadTask` WHERE `id` = :id", {"id": task_id}) if has_table(db, "DownloadTask") else None
    if not task:
        raise ValueError("下载任务不存在")
    if task.get("status") not in {"queued", "failed", "PENDING", "FAILED"}:
        return DownloadExecutionResult(task)

    update_row(db, "DownloadTask", task_id, {"status": "downloading", "progress": 1, "errorMessage": None, "updatedAt": now()})
    try:
        file_path = run_task(db, settings, {**task, "status": "downloading"})
        updated = update_row(
            db,
            "DownloadTask",
            task_id,
            {"status": "downloaded", "progress": 100, "filePath": str(file_path), "savePath": str(settings.resolved_download_inbox_path), "errorMessage": None, "updatedAt": now()},
        )
        return DownloadExecutionResult(updated or task)
    except Exception as exc:
        updated = update_row(db, "DownloadTask", task_id, {"status": "failed", "errorMessage": error_summary(exc), "updatedAt": now()})
        return DownloadExecutionResult(updated or task)


def validate_inbox_file(settings: Settings, file_path: str | None) -> Path:
    if not file_path:
        raise ValueError("下载任务没有可导入文件")
    inbox = settings.resolved_download_inbox_path
    resolved = Path(file_path).expanduser().resolve()
    if inbox != resolved and inbox not in resolved.parents:
        raise ValueError("只能导入下载队列中的文件")
    if not resolved.exists() or not resolved.is_file():
        raise ValueError("下载任务文件不存在或不是普通文件")
    return resolved


def load_qbittorrent_manifest(file_path: Path) -> dict[str, Any] | None:
    if file_path.suffix.lower() != ".json":
        return None
    try:
        payload = json.loads(file_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) and payload.get("type") == "qbittorrent_submission" else None


def configured_qbittorrent_save_root(config: QbittorrentConfig, manifest: dict[str, Any]) -> Path:
    save_path = string_value(manifest.get("savePath")) or string_value(config.save_path)
    if not save_path:
        raise ValueError("qBittorrent 任务缺少保存目录，无法拾取完成文件")
    return Path(save_path).expanduser().resolve()


def find_qbittorrent_completed_file(config: QbittorrentConfig, manifest: dict[str, Any], task: dict[str, Any]) -> Path:
    root = configured_qbittorrent_save_root(config, manifest)
    if not root.exists() or not root.is_dir():
        raise ValueError("qBittorrent 保存目录不存在或不可访问")
    expected_values = [
        string_value(manifest.get("completedFile")),
        string_value(manifest.get("expectedName")),
        string_value(task.get("displayName")),
    ]
    candidates: list[Path] = []
    for value in expected_values:
        if not value:
            continue
        candidate = (root / sanitize_filename(value)).resolve()
        if root == candidate or root in candidate.parents:
            candidates.append(candidate)
        stem = sanitize_filename(Path(value).stem)
        if stem:
            candidates.extend(path for path in root.rglob(f"{stem}.*") if path.is_file())
    candidates.extend(path for path in root.rglob("*") if path.is_file())
    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if root != resolved and root not in resolved.parents:
            continue
        if resolved.suffix.lower() in SUPPORTED_IMPORT_EXTENSIONS and resolved.exists() and resolved.stat().st_size > 0:
            return resolved
    raise ValueError("未在 qBittorrent 保存目录中找到可导入的 EPUB、CBZ、ZIP 或 PDF 文件")


def stage_completed_download_to_inbox(settings: Settings, source: Path) -> Path:
    assert_allowed_extension(source.name)
    target = unique_inbox_path(settings, source.name)
    shutil.copy2(source, target)
    return target


def resolve_download_import_file(db: Session, settings: Settings, task: dict[str, Any]) -> Path:
    qbit = qbittorrent_config(db, settings)
    try:
        file_path = validate_inbox_file(settings, task.get("filePath"))
    except Exception:
        raw_path = task.get("filePath")
        candidate = Path(raw_path).expanduser().resolve() if raw_path else None
        manifest = load_qbittorrent_manifest(candidate) if candidate and candidate.exists() else None
        if not manifest:
            raise
        completed = find_qbittorrent_completed_file(qbit, manifest, task)
        return stage_completed_download_to_inbox(settings, completed)
    manifest = load_qbittorrent_manifest(file_path)
    if manifest:
        completed = find_qbittorrent_completed_file(qbit, manifest, task)
        return stage_completed_download_to_inbox(settings, completed)
    return file_path


def import_download_task(db: Session, settings: Settings, task_id: str) -> DownloadExecutionResult:
    task = row(db, "SELECT * FROM `DownloadTask` WHERE `id` = :id", {"id": task_id}) if has_table(db, "DownloadTask") else None
    if not task:
        raise ValueError("下载任务不存在")
    if task.get("status") != "downloaded":
        raise ValueError("只有已下载任务可以导入书库")

    try:
        file_path = resolve_download_import_file(db, settings, task)
    except Exception as exc:
        update_row(db, "DownloadTask", task_id, {"status": "failed", "errorMessage": error_summary(exc), "updatedAt": now()})
        if task.get("searchRecordId") and has_table(db, "SourceSearchRecord"):
            update_row(db, "SourceSearchRecord", task["searchRecordId"], {"status": "failed", "updatedAt": now()})
        raise

    update_row(db, "DownloadTask", task_id, {"status": "importing", "filePath": str(file_path), "errorMessage": None, "updatedAt": now()})
    try:
        result = import_managed_book(db, settings, ImportOptions(source_file_path=file_path, original_name=file_path.name, origin="MANUAL"))
        updated = update_row(
            db,
            "DownloadTask",
            task_id,
            {"status": "completed", "bookId": result.book_id, "progress": 100, "errorMessage": None, "updatedAt": now()},
        )
        if task.get("searchRecordId") and has_table(db, "SourceSearchRecord"):
            update_row(db, "SourceSearchRecord", task["searchRecordId"], {"status": "completed", "updatedAt": now()})
        return DownloadExecutionResult(updated or task, import_result=result)
    except Exception as exc:
        updated = update_row(db, "DownloadTask", task_id, {"status": "failed", "errorMessage": error_summary(exc), "updatedAt": now()})
        if task.get("searchRecordId") and has_table(db, "SourceSearchRecord"):
            update_row(db, "SourceSearchRecord", task["searchRecordId"], {"status": "failed", "updatedAt": now()})
        return DownloadExecutionResult(updated or task)


def find_active_download_task(db: Session, record_id: str) -> dict[str, Any] | None:
    if not has_table(db, "DownloadTask"):
        return None
    placeholders = ", ".join(f":status_{index}" for index, _ in enumerate(ACTIVE_DOWNLOAD_STATUSES))
    params = {f"status_{index}": status for index, status in enumerate(ACTIVE_DOWNLOAD_STATUSES)}
    params["record_id"] = record_id
    return row(db, f"SELECT * FROM `DownloadTask` WHERE `searchRecordId` = :record_id AND `status` IN ({placeholders}) ORDER BY `createdAt` DESC LIMIT 1", params)
