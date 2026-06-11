from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from html import unescape
from time import time_ns
from typing import Any
from urllib.parse import urlencode, urljoin
from urllib.request import Request as UrlRequest
from urllib.request import urlopen

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session


@dataclass(frozen=True)
class ApplyResult:
    job: dict[str, Any]
    applied: int
    applied_external: int
    auto_marked_organized: bool
    dismissed: bool
    duplicate_actions_applied: int


def now() -> datetime:
    return datetime.now(timezone.utc)


def has_table(db: Session, table: str) -> bool:
    return table in inspect(db.get_bind()).get_table_names()


def columns(db: Session, table: str) -> set[str]:
    return {column["name"] for column in inspect(db.get_bind()).get_columns(table)} if has_table(db, table) else set()


def row(db: Session, sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
    result = db.execute(text(sql), params or {}).mappings().first()
    return dict(result) if result else None


def rows(db: Session, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    return [dict(item) for item in db.execute(text(sql), params or {}).mappings().all()]


def update_row(db: Session, table: str, row_id: str, values: dict[str, Any]) -> dict[str, Any] | None:
    allowed = columns(db, table)
    filtered = {key: value for key, value in values.items() if key in allowed}
    if filtered:
        params = {**filtered, "row_id": row_id}
        assignments = ", ".join(f"`{key}` = :{key}" for key in filtered)
        db.execute(text(f"UPDATE `{table}` SET {assignments} WHERE `id` = :row_id"), params)
        db.commit()
    return row(db, f"SELECT * FROM `{table}` WHERE `id` = :id", {"id": row_id})


def update_rows(db: Session, table: str, where_sql: str, params: dict[str, Any], values: dict[str, Any]) -> int:
    allowed = columns(db, table)
    filtered = {key: value for key, value in values.items() if key in allowed}
    if not filtered:
        return 0
    update_params = {**params, **filtered}
    assignments = ", ".join(f"`{key}` = :{key}" for key in filtered)
    result = db.execute(text(f"UPDATE `{table}` SET {assignments} WHERE {where_sql}"), update_params)
    db.commit()
    return result.rowcount or 0


def insert_row(db: Session, table: str, values: dict[str, Any]) -> dict[str, Any]:
    allowed = columns(db, table)
    filtered = {key: value for key, value in values.items() if key in allowed}
    keys = ", ".join(f"`{key}`" for key in filtered)
    params = ", ".join(f":{key}" for key in filtered)
    db.execute(text(f"INSERT INTO `{table}` ({keys}) VALUES ({params})"), filtered)
    db.commit()
    return row(db, f"SELECT * FROM `{table}` WHERE `id` = :id", {"id": filtered["id"]}) or filtered


def parse_json_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list, int, float, bool)):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            return value
    return value


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def string_value(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def coerce_bool(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def first_string(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, list):
            first = next((str(item.get("name", item) if isinstance(item, dict) else item).strip() for item in value if str(item.get("name", item) if isinstance(item, dict) else item).strip()), None)
            if first:
                return first
    return None


def string_array(value: Any) -> list[str]:
    if isinstance(value, list):
        return [item for item in (str(item.get("name", item) if isinstance(item, dict) else item).strip() for item in value) if item]
    if isinstance(value, str):
        return [item.strip() for item in re.split(r"[,，;/]", value) if item.strip()]
    return []


def extract_year(value: Any) -> int | None:
    match = re.search(r"\b(19\d{2}|20\d{2})\b", str(value or ""))
    return int(match.group(1)) if match else None


def normalize_key(value: Any) -> str:
    return re.sub(r"[\s_\-.[\]()（）【】《》:：,，!！?？\"'“”‘’]+", "", str(value or "").lower()).strip()


def system_settings(db: Session, keys: list[str]) -> dict[str, str | None]:
    if not has_table(db, "SystemSetting"):
        return {key: None for key in keys}
    placeholders = ", ".join(f":key_{index}" for index, _ in enumerate(keys))
    params = {f"key_{index}": key for index, key in enumerate(keys)}
    found = {item["key"]: item.get("value") for item in rows(db, f"SELECT `key`, `value` FROM `SystemSetting` WHERE `key` IN ({placeholders})", params)}
    return {key: found.get(key) for key in keys}


def selected_suggestions(db: Session, job_id: str, suggestion_ids: list[str] | None, high_confidence_only: bool) -> list[dict[str, Any]]:
    if not has_table(db, "MetadataSuggestion"):
        return []
    suggestions = rows(db, "SELECT * FROM `MetadataSuggestion` WHERE `jobId` = :job_id AND `status` = 'PENDING'", {"job_id": job_id})
    allowed = set(suggestion_ids or [])
    return [
        suggestion
        for suggestion in suggestions
        if (not suggestion_ids or suggestion["id"] in allowed) and (not high_confidence_only or float(suggestion.get("confidence") or 0) >= 0.8)
    ]


def work_patch_from_suggestions(db: Session, suggestions: list[dict[str, Any]]) -> dict[str, Any]:
    allowed = columns(db, "LibraryWork")
    patch: dict[str, Any] = {}
    for suggestion in suggestions:
        field = suggestion.get("field")
        value = parse_json_value(suggestion.get("suggestedValue"))
        if field == "title" and isinstance(value, str) and value.strip():
            patch["title"] = value.strip()
            if "normalizedTitle" in allowed:
                patch["normalizedTitle"] = normalize_key(value)
        elif field == "author" and isinstance(value, str):
            patch["author"] = value.strip() or None
            if "normalizedAuthor" in allowed:
                patch["normalizedAuthor"] = normalize_key(value) or None
        elif field == "description" and isinstance(value, str):
            patch["description"] = value
        elif field == "tags":
            tags = [str(item).strip() for item in value] if isinstance(value, list) else []
            patch["tags"] = json_text(sorted({tag for tag in tags if tag}))
        elif field == "seriesName" and isinstance(value, str) and "seriesName" in allowed:
            patch["seriesName"] = value.strip() or None
        elif field == "seriesIndex" and isinstance(value, (int, float)) and "seriesIndex" in allowed:
            patch["seriesIndex"] = value
        elif field == "publishedYear" and isinstance(value, int) and "publishedYear" in allowed:
            patch["publishedYear"] = value
    return patch


def apply_organize_job(db: Session, job_id: str, payload: dict[str, Any]) -> ApplyResult:
    job = row(db, "SELECT * FROM `OrganizeJob` WHERE `id` = :id", {"id": job_id}) if has_table(db, "OrganizeJob") else None
    if not job:
        raise ValueError("整理任务不存在")
    if payload.get("dismiss"):
        update_row(db, "OrganizeJob", job_id, {"status": "DISMISSED", "updatedAt": now()})
        if job.get("workId") and has_table(db, "LibraryWork"):
            update_row(db, "LibraryWork", job["workId"], {"organizeStatus": "DISMISSED", "updatedAt": now()})
        return ApplyResult(row(db, "SELECT * FROM `OrganizeJob` WHERE `id` = :id", {"id": job_id}) or job, 0, 0, False, True, 0)

    suggestion_ids = [str(item) for item in payload.get("suggestionIds") or []] or None
    high_confidence_only = bool(payload.get("highConfidenceOnly"))
    suggestions = selected_suggestions(db, job_id, suggestion_ids, high_confidence_only)
    patch = work_patch_from_suggestions(db, suggestions)
    mark_organized = bool(payload.get("markOrganized"))
    if mark_organized:
        patch["organized"] = True
        patch["organizeStatus"] = "APPLIED"
    if patch and job.get("workId") and has_table(db, "LibraryWork"):
        patch["updatedAt"] = now()
        update_row(db, "LibraryWork", job["workId"], patch)
    if suggestions and has_table(db, "MetadataSuggestion"):
        placeholders = ", ".join(f":id_{index}" for index, _ in enumerate(suggestions))
        params = {f"id_{index}": suggestion["id"] for index, suggestion in enumerate(suggestions)}
        db.execute(text(f"UPDATE `MetadataSuggestion` SET `status` = 'APPLIED' WHERE `id` IN ({placeholders})"), params)
        db.commit()

    duplicate_ids = [str(item) for item in payload.get("duplicateIds") or [] if str(item)]
    duplicate_actions_applied = apply_duplicate_actions(db, job, duplicate_ids) if duplicate_ids else 0

    if mark_organized:
        if has_table(db, "MetadataSuggestion"):
            db.execute(text("UPDATE `MetadataSuggestion` SET `status` = 'DISMISSED' WHERE `jobId` = :job_id AND `status` = 'PENDING'"), {"job_id": job_id})
        if has_table(db, "DuplicateCandidate"):
            db.execute(text("UPDATE `DuplicateCandidate` SET `status` = 'DISMISSED' WHERE `jobId` = :job_id AND `status` = 'PENDING'"), {"job_id": job_id})
        db.commit()
    updated_job = update_row(db, "OrganizeJob", job_id, {"status": "APPLIED" if mark_organized else job.get("status"), "updatedAt": now()}) or job
    return ApplyResult(updated_job, len(suggestions), sum(1 for item in suggestions if item.get("source") == "external"), False, False, duplicate_actions_applied)


def first_edition_for_work(db: Session, work_id: str) -> dict[str, Any] | None:
    if not has_table(db, "LibraryEdition"):
        return None
    return row(db, "SELECT * FROM `LibraryEdition` WHERE `workId` = :work_id AND COALESCE(`hidden`, 0) = 0 ORDER BY COALESCE(`primary`, 0) DESC, `createdAt` ASC LIMIT 1", {"work_id": work_id})


def set_work_hidden(db: Session, work_id: str, hidden: bool, organize_status: str = "APPLIED") -> None:
    if has_table(db, "LibraryWork"):
        update_row(db, "LibraryWork", work_id, {"hidden": hidden, "organizeStatus": organize_status, "updatedAt": now()})


def choose_primary_edition(db: Session, work_id: str, preferred_id: str | None = None) -> str | None:
    work = row(db, "SELECT * FROM `LibraryWork` WHERE `id` = :id", {"id": work_id}) if has_table(db, "LibraryWork") else None
    primary_id = preferred_id or (work or {}).get("primaryEditionId")
    primary_exists = row(db, "SELECT * FROM `LibraryEdition` WHERE `id` = :id AND `workId` = :work_id", {"id": primary_id, "work_id": work_id}) if primary_id and has_table(db, "LibraryEdition") else None
    if primary_exists:
        return primary_id
    edition = first_edition_for_work(db, work_id)
    primary_id = edition.get("id") if edition else None
    if primary_id:
        update_row(db, "LibraryWork", work_id, {"primaryEditionId": primary_id, "updatedAt": now()})
        update_row(db, "LibraryEdition", primary_id, {"primary": True, "updatedAt": now()})
    return primary_id


def merge_as_version(db: Session, source_work_id: str, target_work_id: str) -> None:
    if source_work_id == target_work_id:
        return
    if has_table(db, "LibraryEdition"):
        update_rows(db, "LibraryEdition", "`workId` = :source_work_id", {"source_work_id": source_work_id}, {"workId": target_work_id, "primary": False, "updatedAt": now()})
    if has_table(db, "ImportTask"):
        update_rows(db, "ImportTask", "`workId` = :source_work_id", {"source_work_id": source_work_id}, {"workId": target_work_id, "updatedAt": now()})
    if has_table(db, "LibraryReadingProgress"):
        update_rows(db, "LibraryReadingProgress", "`workId` = :source_work_id", {"source_work_id": source_work_id}, {"workId": target_work_id, "updatedAt": now()})
    set_work_hidden(db, source_work_id, True)
    choose_primary_edition(db, target_work_id)


def merge_as_volume(db: Session, source_work_id: str, target_work_id: str, target_edition_id: str | None) -> None:
    target_edition_id = choose_primary_edition(db, target_work_id, target_edition_id)
    if not target_edition_id:
        merge_as_version(db, source_work_id, target_work_id)
        return
    source_editions = rows(db, "SELECT * FROM `LibraryEdition` WHERE `workId` = :source_work_id", {"source_work_id": source_work_id}) if has_table(db, "LibraryEdition") else []
    for edition in source_editions:
        source_edition_id = edition["id"]
        if has_table(db, "LibraryVolume"):
            update_rows(db, "LibraryVolume", "`editionId` = :source_edition_id", {"source_edition_id": source_edition_id}, {"editionId": target_edition_id, "updatedAt": now()})
        if has_table(db, "LibraryFile"):
            update_rows(db, "LibraryFile", "`editionId` = :source_edition_id", {"source_edition_id": source_edition_id}, {"editionId": target_edition_id, "updatedAt": now()})
        if has_table(db, "LibraryReadingUnit"):
            update_rows(db, "LibraryReadingUnit", "`editionId` = :source_edition_id", {"source_edition_id": source_edition_id}, {"editionId": target_edition_id, "updatedAt": now()})
        if has_table(db, "LibraryMetadata"):
            update_rows(db, "LibraryMetadata", "`editionId` = :source_edition_id", {"source_edition_id": source_edition_id}, {"editionId": target_edition_id, "updatedAt": now()})
        if has_table(db, "ImportTask"):
            update_rows(db, "ImportTask", "`editionId` = :source_edition_id", {"source_edition_id": source_edition_id}, {"workId": target_work_id, "editionId": target_edition_id, "updatedAt": now()})
        update_row(db, "LibraryEdition", source_edition_id, {"hidden": True, "updatedAt": now()})
    if has_table(db, "LibraryReadingProgress"):
        update_rows(db, "LibraryReadingProgress", "`workId` = :source_work_id", {"source_work_id": source_work_id}, {"workId": target_work_id, "editionId": target_edition_id, "updatedAt": now()})
    set_work_hidden(db, source_work_id, True)


def apply_duplicate_actions(db: Session, job: dict[str, Any], duplicate_ids: list[str]) -> int:
    if not duplicate_ids or not has_table(db, "DuplicateCandidate"):
        return 0
    placeholders = ", ".join(f":id_{index}" for index, _ in enumerate(duplicate_ids))
    params = {f"id_{index}": duplicate_id for index, duplicate_id in enumerate(duplicate_ids)}
    params["job_id"] = job["id"]
    duplicates = rows(db, f"SELECT * FROM `DuplicateCandidate` WHERE `jobId` = :job_id AND `id` IN ({placeholders})", params)
    target_work_id = job.get("workId")
    if not target_work_id:
        return 0
    applied = 0
    for duplicate in duplicates:
        source_work_id = duplicate.get("targetWorkId")
        if not source_work_id or source_work_id == target_work_id:
            continue
        action = string_value(duplicate.get("suggestedAction")) or "KEEP_SEPARATE"
        if action == "HIDE_DUPLICATE":
            set_work_hidden(db, source_work_id, True)
        elif action == "MERGE_AS_VERSION":
            merge_as_version(db, source_work_id, target_work_id)
        elif action == "MERGE_AS_VOLUME":
            merge_as_volume(db, source_work_id, target_work_id, job.get("editionId"))
        update_row(db, "DuplicateCandidate", duplicate["id"], {"status": "APPLIED", "updatedAt": now()})
        applied += 1
    return applied


def issue_codes_for_work(work: dict[str, Any], editions: list[dict[str, Any]], duplicate: bool) -> list[str]:
    issues: list[str] = []
    if not work.get("organized"):
        issues.append("NEW_IMPORT")
    if not work.get("coverPath") or work.get("coverStatus") != "READY":
        issues.append("MISSING_COVER")
    if not str(work.get("author") or "").strip():
        issues.append("MISSING_AUTHOR")
    title = str(work.get("title") or "").strip()
    if len(title) < 2 or re.search(r"\.(epub|cbz|zip|pdf|txt)$", title, re.I) or re.fullmatch(r"[0-9a-f]{16,}", title, re.I):
        issues.append("ODD_TITLE")
    if any(edition.get("importStatus") == "FAILED" or edition.get("importError") for edition in editions):
        issues.append("IMPORT_FAILED")
    if duplicate:
        issues.append("DUPLICATE")
    return list(dict.fromkeys(issues))


def refresh_organize_job(db: Session, job_id: str) -> dict[str, Any]:
    job = row(db, "SELECT * FROM `OrganizeJob` WHERE `id` = :id", {"id": job_id}) if has_table(db, "OrganizeJob") else None
    if not job:
        raise ValueError("整理任务不存在")
    work = row(db, "SELECT * FROM `LibraryWork` WHERE `id` = :id", {"id": job.get("workId")}) if has_table(db, "LibraryWork") and job.get("workId") else None
    if not work:
        return update_row(db, "OrganizeJob", job_id, {"status": "FAILED", "errorSummary": "作品不存在", "updatedAt": now()}) or job
    editions = rows(db, "SELECT * FROM `LibraryEdition` WHERE `workId` = :work_id", {"work_id": work["id"]}) if has_table(db, "LibraryEdition") else []
    duplicate_count = refresh_duplicate_candidates(db, job, work)
    issues = issue_codes_for_work(work, editions, duplicate_count > 0)
    status = "REVIEWING" if issues else "APPLIED"
    summary = f"发现 {len(issues)} 类整理问题，{duplicate_count} 条重复/版本候选" if issues or duplicate_count else "未发现需要整理的问题"
    updated_job = update_row(db, "OrganizeJob", job_id, {"status": status, "issueCodes": json_text(issues), "summary": summary, "errorSummary": None, "updatedAt": now()}) or job
    update_row(db, "LibraryWork", work["id"], {"organizeStatus": status, "metadataQuality": max(0, 100 - len(issues) * 15), "organized": status == "APPLIED" or bool(work.get("organized")), "updatedAt": now()})
    return {**updated_job, "refreshed": True, "issueCodes": issues, "duplicateCount": duplicate_count}


def ensure_organize_job_for_work(db: Session, work_id: str) -> dict[str, Any] | None:
    if not has_table(db, "OrganizeJob") or not has_table(db, "LibraryWork"):
        return None
    work = row(db, "SELECT * FROM `LibraryWork` WHERE `id` = :id AND COALESCE(`hidden`, 0) = 0", {"id": work_id})
    if not work:
        return None
    existing = row(
        db,
        "SELECT * FROM `OrganizeJob` WHERE `workId` = :work_id AND `status` IN ('PENDING', 'REVIEWING') ORDER BY `updatedAt` DESC LIMIT 1",
        {"work_id": work_id},
    )
    if existing:
        return existing
    edition_id = work.get("primaryEditionId")
    if not edition_id and has_table(db, "LibraryEdition"):
        edition = row(db, "SELECT * FROM `LibraryEdition` WHERE `workId` = :work_id ORDER BY `createdAt` ASC LIMIT 1", {"work_id": work_id})
        edition_id = edition.get("id") if edition else None
    return insert_row(
        db,
        "OrganizeJob",
        {
            "id": f"py_{time_ns()}",
            "workId": work_id,
            "editionId": edition_id,
            "status": "REVIEWING",
            "issueCodes": json_text(["NEW_IMPORT"] if not work.get("organized") else []),
            "summary": "等待元数据刷新",
            "createdAt": now(),
            "updatedAt": now(),
        },
    )


def context_for_job(db: Session, job: dict[str, Any]) -> dict[str, Any] | None:
    work = row(db, "SELECT * FROM `LibraryWork` WHERE `id` = :id", {"id": job.get("workId")}) if has_table(db, "LibraryWork") and job.get("workId") else None
    if not work:
        return None
    editions = rows(db, "SELECT * FROM `LibraryEdition` WHERE `workId` = :work_id", {"work_id": work["id"]}) if has_table(db, "LibraryEdition") else []
    files = []
    metadata = []
    if has_table(db, "LibraryFile"):
        for edition in editions:
            files.extend(rows(db, "SELECT * FROM `LibraryFile` WHERE `editionId` = :edition_id", {"edition_id": edition["id"]}))
    if has_table(db, "LibraryMetadata"):
        for edition in editions:
            metadata.extend(rows(db, "SELECT * FROM `LibraryMetadata` WHERE `editionId` = :edition_id", {"edition_id": edition["id"]}))
    return {"work": work, "editions": editions, "files": files, "metadata": metadata}


def local_metadata_summary(context: dict[str, Any]) -> dict[str, Any]:
    work = context["work"]
    files = context["files"][:8]
    metadata = [parse_json_value(item.get("rawJson")) for item in context["metadata"][:4]]
    return {
        "title": work.get("title"),
        "author": work.get("author"),
        "seriesName": work.get("seriesName"),
        "seriesIndex": work.get("seriesIndex"),
        "publishedYear": work.get("publishedYear"),
        "tags": parse_json_value(work.get("tags")) or [],
        "fileNames": [str(file.get("path") or "").rsplit("/", 1)[-1] for file in files],
        "parentPaths": sorted({str(file.get("path") or "").rsplit("/", 1)[0] for file in files if "/" in str(file.get("path") or "")}),
        "embeddedMetadata": metadata,
    }


def normalize_ai_confidence(value: Any) -> float:
    try:
        parsed = float(value if value is not None else 0.6)
    except (TypeError, ValueError):
        parsed = 0.6
    return min(0.74, max(0.0, parsed))


def suggestion_from_ai_item(item: dict[str, Any]) -> dict[str, Any] | None:
    field = item.get("field")
    if field not in {"title", "author", "description", "tags", "seriesName", "seriesIndex", "publishedYear"}:
        return None
    value = item.get("value")
    if value is None or value == "" or value == []:
        return None
    return {
        "field": field,
        "suggestedValue": json_text(value) if isinstance(value, (dict, list, int, float, bool)) else str(value),
        "source": "ai",
        "confidence": normalize_ai_confidence(item.get("confidence")),
        "reason": f"AI 识别：{string_value(item.get('reason')) or '根据本地元数据摘要推断'}",
        "status": "PENDING",
    }


def suggestion_from_external(field: str, value: Any, confidence: float, reason: str, source: str = "external") -> dict[str, Any] | None:
    if field not in {"title", "author", "description", "tags", "seriesName", "seriesIndex", "publishedYear"}:
        return None
    if value is None or value == "" or value == []:
        return None
    return {
        "field": field,
        "suggestedValue": json_text(value) if isinstance(value, (dict, list, int, float, bool)) else str(value),
        "source": source,
        "confidence": confidence,
        "reason": reason,
        "status": "PENDING",
    }


def douban_candidates(payload: Any, confidence: float) -> list[dict[str, Any]]:
    raw = payload if isinstance(payload, dict) else {}
    books = (
        raw.get("books")
        if isinstance(raw.get("books"), list)
        else raw.get("items")
        if isinstance(raw.get("items"), list)
        else raw.get("results")
        if isinstance(raw.get("results"), list)
        else raw.get("subjects")
        if isinstance(raw.get("subjects"), list)
        else raw.get("data")
        if isinstance(raw.get("data"), list)
        else payload
        if isinstance(payload, list)
        else [raw]
        if raw.get("title") or raw.get("id")
        else []
    )
    candidates = []
    for index, item in enumerate(books):
        if not isinstance(item, dict):
            continue
        pubdate = first_string(item.get("pubdate"), item.get("publishedAt"), item.get("date"))
        tags = string_array(item.get("tags")) or string_array(item.get("tag"))
        candidates.append(
            {
                "id": str(item.get("id") or item.get("isbn13") or item.get("isbn10") or item.get("url") or f"douban-{index}"),
                "source": "douban",
                "title": first_string(item.get("title"), item.get("subtitle")),
                "author": first_string(item.get("author"), item.get("authors")),
                "publisher": first_string(item.get("publisher")),
                "description": first_string(item.get("summary"), item.get("description")),
                "tags": tags,
                "publishedYear": item.get("publishedYear") if isinstance(item.get("publishedYear"), int) else extract_year(pubdate),
                "coverUrl": first_url(item.get("image"), item.get("coverUrl"), item.get("cover_url"), (item.get("images") or {}).get("large") if isinstance(item.get("images"), dict) else None),
                "confidence": confidence,
                "raw": item,
            }
        )
    return [candidate for candidate in candidates if candidate.get("title") or candidate.get("author") or candidate.get("description")]


def first_url(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip().startswith(("http://", "https://")):
            return value.strip()
    return None


def douban_abstract_parts(value: Any) -> list[str]:
    text_value = first_string(value)
    return [part.strip() for part in text_value.split("/") if part.strip()] if text_value else []


def douban_publisher_from_abstract(value: Any) -> str | None:
    parts = douban_abstract_parts(value)
    if len(parts) >= 5:
        return parts[-3]
    if len(parts) >= 4:
        return parts[1]
    return None


def strip_html(value: str) -> str:
    cleaned = re.sub(r"<script[\s\S]*?</script>", " ", value, flags=re.I)
    cleaned = re.sub(r"<style[\s\S]*?</style>", " ", cleaned, flags=re.I)
    cleaned = re.sub(r"<br\s*/?>", "\n", cleaned, flags=re.I)
    cleaned = re.sub(r"</p\s*>", "\n", cleaned, flags=re.I)
    cleaned = re.sub(r"<[^>]+>", " ", cleaned)
    return re.sub(r"[ \t\r\f\v]+", " ", unescape(cleaned)).strip()


def attrs_from_tag(tag: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for match in re.finditer(r"([:\w-]+)\s*=\s*(['\"])(.*?)\2", tag, re.S):
        attrs[match.group(1).lower()] = unescape(match.group(3)).strip()
    return attrs


def meta_content(html: str, property_name: str) -> str | None:
    for match in re.finditer(r"<meta\b[^>]*>", html, re.I):
        attrs = attrs_from_tag(match.group(0))
        if attrs.get("property") == property_name or attrs.get("name") == property_name:
            return attrs.get("content") or None
    return None


def parse_json_ld_book(html: str) -> dict[str, Any] | None:
    match = re.search(r"<script\s+type=['\"]application/ld\+json['\"][^>]*>([\s\S]*?)</script>", html, re.I)
    if not match:
        return None
    try:
        payload = json.loads(match.group(1).strip())
        return payload if isinstance(payload, dict) else None
    except json.JSONDecodeError:
        return None


def parse_douban_info_block(html: str) -> dict[str, str]:
    match = re.search(r"<div\s+id=['\"]info['\"][^>]*>([\s\S]*?)</div>", html, re.I)
    if not match:
        return {}
    text_value = strip_html(match.group(1))
    text_value = re.sub(r"\s*(作者|出版社|出版年|ISBN|页数|定价|装帧|副标题|原作名|译者):\s*", r"\n\1: ", text_value)
    fields: dict[str, str] = {}
    for line in [item.strip() for item in text_value.split("\n") if item.strip()]:
        field_match = re.match(r"^(作者|出版社|出版年|ISBN|页数|定价|装帧|副标题|原作名|译者):\s*(.+)$", line)
        if field_match:
            fields[field_match.group(1)] = field_match.group(2).strip()
    return fields


def parse_douban_intro(html: str) -> str | None:
    heading = re.search(r"<h2>\s*<span>\s*内容简介\s*</span>", html, re.I)
    if not heading:
        return meta_content(html, "og:description")
    rest = html[heading.end() :]
    intro_match = re.search(r"<div\s+class=['\"]intro['\"][^>]*>([\s\S]*?)</div>", rest, re.I)
    if not intro_match:
        return meta_content(html, "og:description")
    return re.sub(r"\n+", "\n", strip_html(intro_match.group(1))).strip()


def parse_douban_subject_html(html: str, fallback: dict[str, Any] | None = None) -> dict[str, Any] | None:
    fallback = fallback or {}
    json_ld = parse_json_ld_book(html) or {}
    info = parse_douban_info_block(html)
    author_value = json_ld.get("author")
    authors = [first_string(item.get("name")) for item in author_value if isinstance(item, dict)] if isinstance(author_value, list) else string_array(author_value)
    authors = [item for item in authors if item]
    url = first_string(json_ld.get("url"), json_ld.get("sameAs"), meta_content(html, "og:url"), fallback.get("id"))
    subject_match = re.search(r"/subject/(\d+)/", url or "")
    title = first_string(json_ld.get("name"), meta_content(html, "og:title"), fallback.get("title"))
    author = (authors[0] if authors else None) or first_string(info.get("作者"), fallback.get("author"))
    description = first_string(parse_douban_intro(html), fallback.get("description"))
    pubdate = first_string(info.get("出版年"), (fallback.get("raw") or {}).get("pubdate") if isinstance(fallback.get("raw"), dict) else None)
    publisher = first_string(info.get("出版社"), fallback.get("publisher"), (fallback.get("raw") or {}).get("publisher") if isinstance(fallback.get("raw"), dict) else None)
    cover_url = first_url(meta_content(html, "og:image"), fallback.get("coverUrl"))
    isbn = first_string(json_ld.get("isbn"), meta_content(html, "book:isbn"), info.get("ISBN"))
    if not title and not author and not description:
        return None
    candidate_id = subject_match.group(1) if subject_match else str(fallback.get("id") or f"douban-{normalize_key(url or title)}")
    return {
        "id": candidate_id,
        "source": "douban",
        "title": title,
        "author": author,
        "publisher": publisher,
        "description": description,
        "tags": fallback.get("tags") if isinstance(fallback.get("tags"), list) else [],
        "publishedYear": extract_year(pubdate),
        "coverUrl": cover_url,
        "confidence": float(fallback.get("confidence") or 0.78),
        "raw": {**(fallback.get("raw") if isinstance(fallback.get("raw"), dict) else {}), "id": candidate_id, "url": url, "isbn": isbn, "pubdate": pubdate, "publisher": publisher, "coverUrl": cover_url},
    }


def parse_douban_search_html(html: str, confidence: float) -> list[dict[str, Any]]:
    match = re.search(r"window\.__DATA__\s*=\s*(\{[\s\S]*?\})\s*;", html)
    if not match:
        return []
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        return []
    items = payload.get("items") if isinstance(payload, dict) and isinstance(payload.get("items"), list) else []
    candidates: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict) or item.get("tpl_name") != "search_subject" or "/subject/" not in str(item.get("url") or ""):
            continue
        abstract = first_string(item.get("abstract"))
        abstract_parts = douban_abstract_parts(abstract)
        subject_match = re.search(r"/subject/(\d+)/", str(item.get("url") or ""))
        cover_url = first_url(item.get("cover_url"))
        candidates.append(
            {
                "id": str(item.get("id") or (subject_match.group(1) if subject_match else f"douban-{normalize_key(item.get('title'))}")),
                "source": "douban",
                "title": first_string(item.get("title")),
                "author": abstract_parts[0] if abstract_parts else None,
                "publisher": douban_publisher_from_abstract(abstract),
                "description": first_string(item.get("abstract_2")),
                "tags": [],
                "publishedYear": extract_year(abstract),
                "coverUrl": cover_url,
                "confidence": confidence,
                "raw": {**item, "url": first_string(item.get("url")), "coverUrl": cover_url},
            }
        )
    return [candidate for candidate in candidates if candidate.get("title") or candidate.get("author")]


def normalize_douban_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    raw = candidate.get("raw") if isinstance(candidate.get("raw"), dict) else {}
    return {
        **candidate,
        "publisher": first_string(candidate.get("publisher"), raw.get("publisher"), douban_publisher_from_abstract(raw.get("abstract"))),
        "coverUrl": first_url(candidate.get("coverUrl"), raw.get("coverUrl"), raw.get("cover_url"), raw.get("image")),
    }


def douban_crawler_headers(settings: dict[str, str | None]) -> dict[str, str]:
    return {
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "User-Agent": string_value(settings.get("metadata.douban.userAgent")) or "ShukuStarship/0.1 (+https://github.com/GMD170629/shuku-starship)",
        "Referer": "https://book.douban.com",
    }


def douban_base_url(settings: dict[str, str | None]) -> str:
    return string_value(settings.get("metadata.douban.baseUrl")).rstrip("/") or "https://book.douban.com"


def fetch_text(url: str, headers: dict[str, str]) -> str:
    request = UrlRequest(url, headers=headers)
    with urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def fetch_douban_subject(base_url: str, subject_url: str, headers: dict[str, str], fallback: dict[str, Any]) -> dict[str, Any] | None:
    url = subject_url if subject_url.startswith(("http://", "https://")) else urljoin(f"{base_url}/", subject_url.lstrip("/"))
    return parse_douban_subject_html(fetch_text(url, headers), fallback)


def run_douban_crawler_provider(context: dict[str, Any], settings: dict[str, str | None], query: str | None = None) -> dict[str, Any]:
    base_url = douban_base_url(settings)
    headers = douban_crawler_headers(settings)
    edition = next(iter(context["editions"]), {})
    isbn = first_string(edition.get("isbn"), edition.get("identifier"))
    title = first_string(context["work"].get("title")) or ""
    author = first_string(context["work"].get("author")) or ""
    query_text = query or isbn or " ".join(part for part in [title, author] if part)
    confidence = 0.9 if isbn else 0.8 if author else 0.7
    if not query_text:
        return {"provider": "douban", "enabled": True, "added": 0, "cacheHit": False, "message": "豆瓣查询文本为空", "suggestions": []}

    subject_match = re.search(r"(?:book\.douban\.com/subject/)?(\d{4,})", query_text)
    if subject_match and "/subject/" in query_text:
        candidate = fetch_douban_subject(base_url, f"/subject/{subject_match.group(1)}/", headers, {"confidence": confidence})
    else:
        search_html = fetch_text(f"{base_url}/subject_search?{urlencode({'search_text': query_text})}", headers)
        candidates = [normalize_douban_candidate(candidate) for candidate in parse_douban_search_html(search_html, confidence)]
        first = candidates[0] if candidates else None
        subject_url = first_string((first.get("raw") or {}).get("url")) if isinstance(first, dict) and isinstance(first.get("raw"), dict) else None
        try:
            subject_candidate = fetch_douban_subject(base_url, subject_url, headers, first) if first and subject_url else None
        except Exception:
            subject_candidate = None
        candidate = subject_candidate or first
    if not candidate:
        return {"provider": "douban", "enabled": True, "added": 0, "cacheHit": False, "message": "豆瓣未找到匹配图书", "suggestions": []}
    normalized_candidate = normalize_douban_candidate(candidate)
    suggestions = douban_book_suggestions(normalized_candidate, float(candidate.get("confidence") or confidence))
    message = None if suggestions else "豆瓣未找到可用候选字段"
    return {"provider": "douban", "enabled": True, "added": 0, "cacheHit": False, "message": message, "suggestions": suggestions, "candidates": [normalized_candidate]}


def douban_book_suggestions(payload: Any, confidence: float) -> list[dict[str, Any]]:
    book = next(iter(douban_candidates(payload, confidence)), None)
    if not book:
        return []
    raw = [
        suggestion_from_external("title", book.get("title"), confidence, "外部数据源 · 豆瓣：匹配图书标题", "douban"),
        suggestion_from_external("author", book.get("author"), confidence, "外部数据源 · 豆瓣：匹配作者", "douban"),
        suggestion_from_external("description", book.get("description"), min(confidence, 0.82), "外部数据源 · 豆瓣：补全简介", "douban"),
        suggestion_from_external("tags", book.get("tags"), min(confidence, 0.76), "外部数据源 · 豆瓣：补全标签", "douban"),
        suggestion_from_external("publishedYear", book.get("publishedYear"), min(confidence, 0.82), "外部数据源 · 豆瓣：补全出版年", "douban"),
    ]
    return [item for item in raw if item]


def number_or_none(value: Any) -> int | float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not parsed or not (parsed == parsed):
        return None
    return int(parsed) if parsed.is_integer() else parsed


def bangumi_candidates(payload: Any, confidence: float) -> list[dict[str, Any]]:
    raw = payload if isinstance(payload, dict) else {}
    data = (
        raw.get("data")
        if isinstance(raw.get("data"), list)
        else raw.get("list")
        if isinstance(raw.get("list"), list)
        else raw.get("results")
        if isinstance(raw.get("results"), list)
        else payload
        if isinstance(payload, list)
        else [raw]
        if raw.get("name") or raw.get("name_cn") or raw.get("id")
        else []
    )
    candidates = []
    for index, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        tags = [str(tag if isinstance(tag, str) else tag.get("name", "")).strip() for tag in item.get("tags", []) if str(tag if isinstance(tag, str) else tag.get("name", "")).strip()] if isinstance(item.get("tags"), list) else []
        infobox = item.get("infobox") if isinstance(item.get("infobox"), list) else []
        authors = []
        publisher = None
        volume = None
        for entry in infobox:
            if not isinstance(entry, dict):
                continue
            key = str(entry.get("key") or "")
            value = entry.get("value")
            if re.search(r"作者|作画|原作", key):
                authors.extend(string_array(value))
            if publisher is None and re.search(r"出版社|发行|发售|厂牌|连载杂志", key):
                publisher = value
            if volume is None and re.search(r"册数|卷数|话数", key):
                volume = value
        date = first_string(item.get("date"), item.get("air_date"))
        images = item.get("images") if isinstance(item.get("images"), dict) else {}
        candidates.append(
            {
                "id": str(item.get("id") or item.get("url") or f"bangumi-{index}"),
                "source": "bangumi",
                "title": first_string(item.get("name_cn"), item.get("name")),
                "author": authors[0] if authors else None,
                "publisher": first_string(publisher),
                "description": first_string(item.get("summary")),
                "tags": tags[:8],
                "seriesName": first_string(item.get("name_cn"), item.get("name")),
                "seriesIndex": number_or_none(volume),
                "publishedYear": extract_year(date),
                "coverUrl": first_url(images.get("large"), images.get("common"), images.get("medium"), images.get("small"), item.get("image")),
                "confidence": confidence,
                "raw": item,
            }
        )
    return [candidate for candidate in candidates if candidate.get("title") or candidate.get("description")]


def bangumi_subject_suggestions(payload: Any, confidence: float) -> list[dict[str, Any]]:
    subject = next(iter(bangumi_candidates(payload, confidence)), None)
    if not subject:
        return []
    raw = [
        suggestion_from_external("title", subject.get("title"), confidence, "外部数据源 · Bangumi：匹配条目", "bangumi"),
        suggestion_from_external("author", subject.get("author"), min(confidence, 0.78), "外部数据源 · Bangumi：补全作者/原作", "bangumi"),
        suggestion_from_external("description", subject.get("description"), min(confidence, 0.8), "外部数据源 · Bangumi：补全简介", "bangumi"),
        suggestion_from_external("tags", subject.get("tags"), min(confidence, 0.72), "外部数据源 · Bangumi：补全标签", "bangumi"),
        suggestion_from_external("seriesName", subject.get("seriesName"), min(confidence, 0.82), "外部数据源 · Bangumi：补全系列名", "bangumi"),
        suggestion_from_external("publishedYear", subject.get("publishedYear"), min(confidence, 0.78), "外部数据源 · Bangumi：补全出版年", "bangumi"),
    ]
    return [item for item in raw if item]


def ai_suggestions_from_payload(payload: Any) -> list[dict[str, Any]]:
    raw = payload if isinstance(payload, dict) else {}
    choices = raw.get("choices")
    message = choices[0].get("message") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    parsed = parse_json_value(re.sub(r"^```json\s*|\s*```$", "", content.strip(), flags=re.I)) if isinstance(content, str) else raw
    suggestions = parsed.get("suggestions") if isinstance(parsed, dict) else []
    return [suggestion for item in suggestions if isinstance(item, dict) and (suggestion := suggestion_from_ai_item(item))]


def run_ai_metadata_provider(db: Session, context: dict[str, Any], force: bool = True) -> dict[str, Any]:
    settings = system_settings(db, ["metadata.ai.enabled", "metadata.ai.baseUrl", "metadata.ai.apiKey", "metadata.ai.model"])
    if not force and not coerce_bool(settings.get("metadata.ai.enabled")):
        return {"provider": "ai", "enabled": False, "added": 0, "cacheHit": False, "message": "AI 元数据识别未启用", "suggestions": []}
    base_url = string_value(settings.get("metadata.ai.baseUrl")).rstrip("/")
    api_key = string_value(settings.get("metadata.ai.apiKey"))
    model = string_value(settings.get("metadata.ai.model"))
    if not base_url or not api_key or not model:
        return {"provider": "ai", "enabled": False, "added": 0, "cacheHit": False, "message": "AI 接口地址、模型或 API Key 未配置", "suggestions": []}
    summary = local_metadata_summary(context)
    body = {
        "model": model,
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": '你是图书元数据整理助手。只返回 JSON，格式为 {"suggestions":[{"field":"title|author|description|tags|seriesName|seriesIndex|publishedYear","value":...,"confidence":0-1,"reason":"..."}]}。不要编造不确定信息。'},
            {"role": "user", "content": json_text(summary)},
        ],
    }
    request = UrlRequest(
        f"{base_url}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Accept": "application/json", "Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return {"provider": "ai", "enabled": True, "added": 0, "cacheHit": False, "suggestions": ai_suggestions_from_payload(payload)}


def run_bangumi_metadata_provider(db: Session, context: dict[str, Any], settings: dict[str, str | None], force: bool = True, query: str | None = None) -> dict[str, Any]:
    if not force and not coerce_bool(settings.get("metadata.bangumi.enabled")):
        return {"provider": "bangumi", "enabled": False, "added": 0, "cacheHit": False, "message": "Bangumi 元数据源未启用", "suggestions": []}
    user_agent = string_value(settings.get("metadata.bangumi.userAgent")) or "Shuku Starship Python"
    if not user_agent:
        return {"provider": "bangumi", "enabled": False, "added": 0, "cacheHit": False, "message": "Bangumi User-Agent 未配置", "suggestions": []}
    base_url = string_value(settings.get("metadata.bangumi.baseUrl")).rstrip("/") or "https://api.bgm.tv"
    headers = {"Accept": "application/json", "Content-Type": "application/json", "User-Agent": user_agent}
    access_token = string_value(settings.get("metadata.bangumi.accessToken"))
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    title = query or first_string(context["work"].get("seriesName"), context["work"].get("title")) or ""
    if not title:
        return {"provider": "bangumi", "enabled": True, "added": 0, "cacheHit": False, "message": "Bangumi 查询文本为空", "suggestions": []}
    request = UrlRequest(
        f"{base_url}/v0/search/subjects",
        data=json.dumps({"keyword": title, "sort": "match", "filter": {"type": [1]}}, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    suggestions = bangumi_subject_suggestions(payload, 0.82)
    message = None if suggestions else "Bangumi 未找到匹配条目"
    return {"provider": "bangumi", "enabled": True, "added": 0, "cacheHit": False, "message": message, "suggestions": suggestions, "candidates": bangumi_candidates(payload, 0.82)}


def run_douban_metadata_provider(db: Session, context: dict[str, Any], settings: dict[str, str | None], force: bool = True, query: str | None = None) -> dict[str, Any]:
    if not force and not coerce_bool(settings.get("metadata.douban.enabled")):
        return {"provider": "douban", "enabled": False, "added": 0, "cacheHit": False, "message": "豆瓣元数据源未启用", "suggestions": []}
    if (settings.get("metadata.douban.mode") or "crawler") != "api":
        return run_douban_crawler_provider(context, settings, query)
    base_url = string_value(settings.get("metadata.douban.baseUrl")).rstrip("/")
    if not base_url:
        return {"provider": "douban", "enabled": False, "added": 0, "cacheHit": False, "message": "豆瓣兼容 API 地址未配置", "suggestions": []}
    edition = next(iter(context["editions"]), {})
    isbn = None if query else first_string(edition.get("isbn"), edition.get("identifier"))
    title = first_string(context["work"].get("title")) or ""
    author = first_string(context["work"].get("author")) or ""
    params: dict[str, str] = {}
    api_key = string_value(settings.get("metadata.douban.apiKey"))
    if api_key:
        params["apikey"] = api_key
    if isbn:
        endpoint = f"/v2/book/isbn/{isbn}"
        confidence = 0.92
    else:
        endpoint = "/v2/book/search"
        params["q"] = query or " ".join(part for part in [title, author] if part)
        params["count"] = "3"
        confidence = 0.82 if author else 0.68
    if endpoint.endswith("/search") and not params.get("q"):
        return {"provider": "douban", "enabled": True, "added": 0, "cacheHit": False, "message": "豆瓣查询文本为空", "suggestions": []}
    query_string = urlencode(params)
    request = UrlRequest(f"{base_url}{endpoint}{'?' + query_string if query_string else ''}", headers={"Accept": "application/json"})
    with urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    suggestions = douban_book_suggestions(payload, confidence)
    message = None if suggestions else "豆瓣未找到匹配图书"
    return {"provider": "douban", "enabled": True, "added": 0, "cacheHit": False, "message": message, "suggestions": suggestions, "candidates": douban_candidates(payload, confidence)}


def run_external_metadata_provider(db: Session, context: dict[str, Any], force: bool = True) -> dict[str, Any]:
    work_type = string_value(context["work"].get("workType")).upper()
    settings = system_settings(
        db,
        [
            "metadata.external.enabled",
            "metadata.douban.enabled",
            "metadata.douban.mode",
            "metadata.douban.baseUrl",
            "metadata.douban.apiKey",
            "metadata.douban.userAgent",
            "metadata.bangumi.enabled",
            "metadata.bangumi.baseUrl",
            "metadata.bangumi.accessToken",
            "metadata.bangumi.userAgent",
        ],
    )
    if not force and not coerce_bool(settings.get("metadata.external.enabled")):
        return {"provider": "external", "enabled": False, "added": 0, "cacheHit": False, "message": "外部数据源未启用", "suggestions": []}
    if work_type == "COMIC":
        return run_bangumi_metadata_provider(db, context, settings, force)
    return run_douban_metadata_provider(db, context, settings, force)


def metadata_search_candidates(db: Session, context: dict[str, Any], source: str, query: str | None = None) -> dict[str, Any]:
    settings = system_settings(
        db,
        [
            "metadata.douban.enabled",
            "metadata.douban.mode",
            "metadata.douban.baseUrl",
            "metadata.douban.apiKey",
            "metadata.douban.userAgent",
            "metadata.bangumi.enabled",
            "metadata.bangumi.baseUrl",
            "metadata.bangumi.accessToken",
            "metadata.bangumi.userAgent",
        ],
    )
    if source == "bangumi":
        result = run_bangumi_metadata_provider(db, context, settings, force=True, query=query)
    elif source == "douban":
        result = run_douban_metadata_provider(db, context, settings, force=True, query=query)
    else:
        ai_result = run_ai_metadata_provider(db, context, force=True)
        fields = {item["field"]: parse_json_value(item.get("suggestedValue")) for item in ai_result.get("suggestions") or []}
        candidate = {
            "id": "ai-suggestion",
            "source": "ai",
            "title": fields.get("title"),
            "author": fields.get("author"),
            "description": fields.get("description"),
            "tags": fields.get("tags") if isinstance(fields.get("tags"), list) else [],
            "seriesName": fields.get("seriesName"),
            "seriesIndex": fields.get("seriesIndex"),
            "publishedYear": fields.get("publishedYear"),
            "confidence": max([float(item.get("confidence") or 0) for item in ai_result.get("suggestions") or []] or [0.0]),
            "raw": {"suggestions": ai_result.get("suggestions") or []},
        }
        result = {**ai_result, "candidates": [candidate] if ai_result.get("suggestions") else []}
    return result


def add_suggestions_to_job(db: Session, job_id: str, suggestions: list[dict[str, Any]]) -> int:
    if not suggestions or not has_table(db, "MetadataSuggestion"):
        return 0
    existing = {
        f"{item.get('field')}:{item.get('source')}:{item.get('suggestedValue')}"
        for item in rows(db, "SELECT `field`, `source`, `suggestedValue` FROM `MetadataSuggestion` WHERE `jobId` = :job_id", {"job_id": job_id})
    }
    added = 0
    for suggestion in suggestions:
        key = f"{suggestion.get('field')}:{suggestion.get('source')}:{suggestion.get('suggestedValue')}"
        if key in existing:
            continue
        insert_row(
            db,
            "MetadataSuggestion",
            {
                "id": f"py_{time_ns()}_{added}",
                "jobId": job_id,
                "createdAt": now(),
                "updatedAt": now(),
                **suggestion,
            },
        )
        existing.add(key)
        added += 1
    return added


def refresh_metadata_providers(db: Session, job_id: str, providers: list[str], force: bool = True) -> dict[str, Any]:
    selected = []
    for provider in providers:
        if provider in {"external", "bangumi", "douban", "ai"} and provider not in selected:
            selected.append(provider)
    if not selected:
        raise ValueError("请选择要刷新的元数据来源")
    job = row(db, "SELECT * FROM `OrganizeJob` WHERE `id` = :id", {"id": job_id}) if has_table(db, "OrganizeJob") else None
    if not job:
        raise ValueError("整理任务不存在")
    context = context_for_job(db, job)
    if not context:
        raise ValueError("读物不存在")
    results = []
    total_added = 0
    for provider in selected:
        try:
            if provider == "external":
                result = run_external_metadata_provider(db, context, force)
            elif provider == "bangumi":
                settings = system_settings(db, ["metadata.bangumi.enabled", "metadata.bangumi.baseUrl", "metadata.bangumi.accessToken", "metadata.bangumi.userAgent"])
                result = run_bangumi_metadata_provider(db, context, settings, force)
            elif provider == "douban":
                settings = system_settings(db, ["metadata.douban.enabled", "metadata.douban.mode", "metadata.douban.baseUrl", "metadata.douban.apiKey", "metadata.douban.userAgent"])
                result = run_douban_metadata_provider(db, context, settings, force)
            else:
                result = run_ai_metadata_provider(db, context, force)
            added = add_suggestions_to_job(db, job_id, result.get("suggestions") or [])
            total_added += added
            results.append({key: value for key, value in {**result, "added": added}.items() if key not in {"suggestions", "candidates"}})
        except Exception as exc:
            results.append({"provider": provider, "enabled": True, "added": 0, "cacheHit": False, "error": str(exc)})
    if total_added > 0:
        update_row(db, "OrganizeJob", job_id, {"status": "REVIEWING", "summary": f"新增 {total_added} 条外部/AI 元数据建议", "updatedAt": now()})
        if job.get("workId") and has_table(db, "LibraryWork"):
            update_row(db, "LibraryWork", job["workId"], {"organizeStatus": "REVIEWING", "organized": False, "updatedAt": now()})
    return {"added": total_added, "results": results}


def refresh_duplicate_candidates(db: Session, job: dict[str, Any], work: dict[str, Any]) -> int:
    if not has_table(db, "DuplicateCandidate") or not has_table(db, "LibraryWork"):
        return 0
    if "jobId" in columns(db, "DuplicateCandidate"):
        db.execute(text("DELETE FROM `DuplicateCandidate` WHERE `jobId` = :job_id AND COALESCE(`status`, 'PENDING') = 'PENDING'"), {"job_id": job["id"]})
        db.commit()
    title_key = normalize_key(work.get("title"))
    if len(title_key) < 4:
        return 0
    candidates = rows(db, "SELECT * FROM `LibraryWork` WHERE `id` != :id AND `hidden` = 0", {"id": work["id"]})
    count = 0
    for candidate in candidates:
        reasons = []
        if normalize_key(candidate.get("title")) == title_key:
            reasons.append("title")
        if not reasons:
            continue
        insert_row(db, "DuplicateCandidate", {"id": f"py_{time_ns()}", "jobId": job["id"], "targetWorkId": candidate["id"], "reasons": json_text(reasons), "confidence": 0.75, "suggestedAction": "MERGE_AS_VERSION", "status": "PENDING", "createdAt": now(), "updatedAt": now()})
        count += 1
    return count


def bulk_apply_organize_jobs(db: Session, job_ids: list[str], payload: dict[str, Any]) -> dict[str, Any]:
    if not job_ids:
        raise ValueError("请选择要批量处理的整理任务")
    if len(job_ids) > 200:
        raise ValueError("单次最多批量处理 200 个整理任务")
    applied = 0
    jobs = 0
    for job_id in job_ids:
        if not row(db, "SELECT * FROM `OrganizeJob` WHERE `id` = :id", {"id": job_id}):
            continue
        result = apply_organize_job(db, job_id, {"highConfidenceOnly": payload.get("highConfidenceOnly", True), "markOrganized": payload.get("markOrganized")})
        applied += result.applied
        jobs += 1
    tags = [str(tag).strip() for tag in payload.get("addTags") or [] if str(tag).strip()]
    if tags and has_table(db, "LibraryWork"):
        for job_id in job_ids:
            job = row(db, "SELECT * FROM `OrganizeJob` WHERE `id` = :id", {"id": job_id})
            if not job:
                continue
            work = row(db, "SELECT * FROM `LibraryWork` WHERE `id` = :id", {"id": job.get("workId")})
            if not work:
                continue
            current = parse_json_value(work.get("tags"))
            current_tags = current if isinstance(current, list) else []
            update_row(db, "LibraryWork", work["id"], {"tags": json_text(sorted({*[str(item).strip() for item in current_tags if str(item).strip()], *tags})), "updatedAt": now()})
    return {"matched": len(job_ids), "jobs": jobs, "applied": applied, "tagsAdded": len(set(tags))}
