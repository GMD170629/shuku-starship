from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import shutil
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any
from xml.etree import ElementTree

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.services.organize_service import apply_organize_job, metadata_title_needs_ai, parse_json_value, refresh_metadata_providers

SUPPORTED_EXTS = {".epub", ".cbz", ".zip", ".pdf"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MAX_EPUB_SIZE_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_SIZE_BYTES = 2 * 1024 * 1024 * 1024


@dataclass(frozen=True)
class ImportOptions:
    source_file_path: Path
    origin: str
    original_name: str | None = None
    monitor_folder_id: str | None = None
    import_task_id: str | None = None
    import_mode: str = "COPY"


@dataclass(frozen=True)
class ImportResult:
    book_id: str
    work_id: str
    edition_id: str
    volume_id: str | None
    title: str
    type: str
    format: str
    total_units: int
    import_status: str
    duplicate: bool
    merged: bool
    merge_reason: str


def is_supported_import_file(path: str | Path) -> bool:
    return Path(path).suffix.lower() in SUPPORTED_EXTS


def import_file_size_limit_bytes_for_ext(ext: str) -> int | None:
    normalized = ext if ext.startswith(".") else f".{ext}"
    normalized = normalized.lower()
    if normalized == ".epub":
        return MAX_EPUB_SIZE_BYTES
    if normalized in {".cbz", ".zip"}:
        return MAX_ARCHIVE_SIZE_BYTES
    return None


def import_managed_book(db: Session, settings: Settings, options: ImportOptions) -> ImportResult:
    source = options.source_file_path.resolve()
    ext = source.suffix.lower()
    if ext not in SUPPORTED_EXTS:
        raise ValueError("当前版本仅支持 EPUB、CBZ、ZIP、PDF 格式。")
    task_id = options.import_task_id or _ensure_import_task(db, options)
    started = time.time()
    _update(db, "ImportTask", task_id, {"status": "PARSING", "progress": 5, "startedAt": _now(), "message": "正在校验文件"})
    _log_import(db, task_id, "info", f"import started: {source}")
    try:
        stat = source.stat()
        if not source.is_file():
            raise ValueError("导入源不是文件")
        limit = import_file_size_limit_bytes_for_ext(ext)
        if limit and stat.st_size > limit:
            raise ValueError(f"文件过大：当前限制 {limit} bytes")
        content_hash = _content_hash(source)
        _update(db, "ImportTask", task_id, {"contentHash": content_hash, "progress": 30, "message": "正在读取元数据"})
        if ext == ".epub":
            result = _import_epub(db, settings, options, task_id, stat.st_size, ext)
        elif ext == ".pdf":
            result = _import_pdf(db, settings, options, task_id, stat.st_size, ext)
        else:
            result = _import_comic(db, settings, options, task_id, stat.st_size, ext)
        _update(
            db,
            "ImportTask",
            task_id,
            {
                "workId": result.work_id,
                "editionId": result.edition_id,
                "volumeId": result.volume_id,
                "status": "COMPLETED",
                "progress": 100,
                "duplicate": result.duplicate,
                "message": "读物已存在，跳过重复导入" if result.duplicate else f"导入完成：{result.merge_reason}",
                "duration": int((time.time() - started) * 1000),
                "finishedAt": _now(),
            },
        )
        if not result.duplicate:
            _create_or_refresh_organize_job(db, result.work_id, result.edition_id, task_id)
            if result.format == "epub":
                _auto_apply_epub_metadata(db, result.work_id, result.edition_id, task_id)
        _log_import(db, task_id, "info", f"import completed: {result.book_id}")
        return result
    except Exception as exc:
        message = str(exc)
        _update(db, "ImportTask", task_id, {"status": "FAILED", "progress": 100, "errorSummary": message, "message": "导入失败，详情见错误信息", "duration": int((time.time() - started) * 1000), "finishedAt": _now()})
        _log_import(db, task_id, "error", message)
        raise


def _import_epub(db: Session, settings: Settings, options: ImportOptions, task_id: str, file_size: int, ext: str) -> ImportResult:
    metadata = parse_epub_metadata(options.source_file_path)
    merge_key = _work_merge_key("epub", metadata["title"], metadata["author"], metadata.get("identifier"), metadata.get("isbn"))
    work, created = _ensure_work(db, {"title": metadata["title"], "author": metadata["author"], "description": metadata.get("description"), "workType": "EPUB", "tags": metadata.get("subjects") or ["epub"], "mergeKey": merge_key, "origin": options.origin, "monitorFolderId": options.monitor_folder_id})
    existing = None if created else _row(db, "SELECT * FROM `LibraryEdition` WHERE `workId` = :work_id AND `format` = 'EPUB' AND `hidden` = 0 ORDER BY `createdAt` ASC LIMIT 1", {"work_id": work["id"]})
    if existing:
        volume = _row(db, "SELECT * FROM `LibraryVolume` WHERE `editionId` = :edition_id ORDER BY `sortOrder` ASC LIMIT 1", {"edition_id": existing["id"]})
        return ImportResult(work["id"], work["id"], existing["id"], (volume or {}).get("id"), work["title"], "ebook", "epub", existing.get("chapterCount") or metadata["chapterCount"], "completed", True, True, "duplicate-epub-metadata")

    staged = None
    cover_path = None
    try:
        managed = _managed_path_for(settings, task_id, ext)
        staged = stage_managed_import_file(options.source_file_path, managed, options.import_mode)
        _update(db, "ImportTask", task_id, {"managedFilePath": str(managed), "message": "正在建立 EPUB 记录"})
        edition = _insert(
            db,
            "LibraryEdition",
            {
                "id": _id(),
                "workId": work["id"],
                "monitorFolderId": options.monitor_folder_id,
                "origin": options.origin,
                "format": "EPUB",
                "versionName": _next_edition_name(db, work["id"], "EPUB"),
                "versionKey": "epub:primary",
                "description": metadata.get("description"),
                "language": metadata.get("language"),
                "publisher": metadata.get("publisher"),
                "publishedAt": metadata.get("publishedAt"),
                "identifier": metadata.get("identifier"),
                "isbn": metadata.get("isbn"),
                "sizeBytes": file_size,
                "chapterCount": metadata["chapterCount"],
                "coverStatus": "PENDING",
                "importStatus": "PARSING",
                "primary": not bool(work.get("primaryEditionId")),
                "hidden": False,
                "createdAt": _now(),
                "updatedAt": _now(),
            },
        )
        if metadata.get("coverPath"):
            cover_path = _extract_epub_cover(settings, staged, work["id"], edition["id"], metadata)
        volume = _insert(db, "LibraryVolume", {"id": _id(), "editionId": edition["id"], "title": "正文", "sortOrder": 0, "chapterCount": metadata["chapterCount"], "coverPath": cover_path, "createdAt": _now(), "updatedAt": _now()})
        managed_stat = staged.stat()
        file = _insert(db, "LibraryFile", {"id": _id(), "editionId": edition["id"], "volumeId": volume["id"], "path": str(staged), "filePathHash": _hash_text(str(staged)), "hashStatus": "PARTIAL_PENDING", "kind": "EPUB", "mimeType": "application/epub+zip", "sizeBytes": file_size, "mtimeMs": int(managed_stat.st_mtime * 1000), "sortOrder": 0, "createdAt": _now(), "updatedAt": _now()})
        for chapter in metadata["chapters"]:
            _insert(db, "LibraryReadingUnit", {"id": _id(), "editionId": edition["id"], "volumeId": volume["id"], "fileId": file["id"], "unitType": "chapter", "title": chapter["title"], "href": chapter["href"], "mediaType": chapter.get("mediaType"), "sortOrder": chapter["sortOrder"], "metadataJson": json.dumps({"idref": chapter.get("idref")}, ensure_ascii=False), "createdAt": _now(), "updatedAt": _now()})
        _insert(db, "LibraryMetadata", {"id": _id(), "editionId": edition["id"], "source": "epub_opf", "rawJson": json.dumps(metadata["rawMetadata"], ensure_ascii=False), "createdAt": _now(), "updatedAt": _now()})
        _update(db, "LibraryEdition", edition["id"], {"coverPath": cover_path, "coverStatus": "READY" if cover_path else "PENDING", "importStatus": "COMPLETED", "updatedAt": _now()})
        _finalize_work_primary(db, work["id"], edition["id"], cover_path)
        return ImportResult(work["id"], work["id"], edition["id"], volume["id"], work["title"], "ebook", "epub", metadata["chapterCount"], "completed", False, not created, "new-work" if created else "same-epub-work")
    except Exception:
        if cover_path:
            Path(cover_path).unlink(missing_ok=True)
        if staged:
            _rollback_staged(options.source_file_path, staged, options.import_mode)
        raise


def _import_pdf(db: Session, settings: Settings, options: ImportOptions, task_id: str, file_size: int, ext: str) -> ImportResult:
    metadata = parse_pdf_metadata(options.source_file_path, options.original_name)
    merge_key = _work_merge_key("pdf", metadata["title"], metadata["author"])
    work, created = _ensure_work(
        db,
        {
            "title": metadata["title"],
            "author": metadata["author"],
            "description": metadata.get("description"),
            "workType": "PDF",
            "tags": metadata.get("tags") or ["pdf"],
            "mergeKey": merge_key,
            "origin": options.origin,
            "monitorFolderId": options.monitor_folder_id,
        },
    )
    existing = None if created else _row(db, "SELECT * FROM `LibraryEdition` WHERE `workId` = :work_id AND `format` = 'PDF' AND `hidden` = 0 ORDER BY `createdAt` ASC LIMIT 1", {"work_id": work["id"]})
    if existing:
        volume = _row(db, "SELECT * FROM `LibraryVolume` WHERE `editionId` = :edition_id ORDER BY `sortOrder` ASC LIMIT 1", {"edition_id": existing["id"]})
        return ImportResult(work["id"], work["id"], existing["id"], (volume or {}).get("id"), work["title"], "ebook", "pdf", existing.get("pageCount") or metadata["pageCount"], "completed", True, True, "duplicate-pdf-metadata")

    staged = None
    cover_path = None
    try:
        managed = _managed_path_for(settings, task_id, ext)
        staged = stage_managed_import_file(options.source_file_path, managed, options.import_mode)
        _update(db, "ImportTask", task_id, {"managedFilePath": str(managed), "message": "正在建立 PDF 记录"})
        edition = _insert(
            db,
            "LibraryEdition",
            {
                "id": _id(),
                "workId": work["id"],
                "monitorFolderId": options.monitor_folder_id,
                "origin": options.origin,
                "format": "PDF",
                "versionName": _next_edition_name(db, work["id"], "PDF"),
                "versionKey": "pdf:primary",
                "description": metadata.get("description"),
                "sizeBytes": file_size,
                "pageCount": metadata["pageCount"],
                "coverStatus": "PENDING",
                "importStatus": "PARSING",
                "primary": not bool(work.get("primaryEditionId")),
                "hidden": False,
                "createdAt": _now(),
                "updatedAt": _now(),
            },
        )
        cover_path = _extract_pdf_cover(settings, staged, work["id"], edition["id"], metadata)
        volume = _insert(db, "LibraryVolume", {"id": _id(), "editionId": edition["id"], "title": "PDF", "sortOrder": 0, "pageCount": metadata["pageCount"], "coverPath": cover_path, "createdAt": _now(), "updatedAt": _now()})
        file = _insert(db, "LibraryFile", {"id": _id(), "editionId": edition["id"], "volumeId": volume["id"], "path": str(staged), "filePathHash": _hash_text(str(staged)), "hashStatus": "PARTIAL_PENDING", "kind": "PDF", "mimeType": "application/pdf", "sizeBytes": file_size, "mtimeMs": int(staged.stat().st_mtime * 1000), "sortOrder": 0, "createdAt": _now(), "updatedAt": _now()})
        for index in range(1, max(1, metadata["pageCount"]) + 1):
            _insert(db, "LibraryReadingUnit", {"id": _id(), "editionId": edition["id"], "volumeId": volume["id"], "fileId": file["id"], "unitType": "page", "title": f"第 {index} 页", "href": str(staged), "mediaType": "application/pdf", "sortOrder": index, "metadataJson": json.dumps({"pageNumber": index, "sourceFileName": options.original_name or options.source_file_path.name}, ensure_ascii=False), "createdAt": _now(), "updatedAt": _now()})
        _insert(db, "LibraryMetadata", {"id": _id(), "editionId": edition["id"], "source": "pdf", "rawJson": json.dumps(metadata["rawMetadata"], ensure_ascii=False), "createdAt": _now(), "updatedAt": _now()})
        _update(db, "LibraryEdition", edition["id"], {"coverPath": cover_path, "coverStatus": "READY" if cover_path else "PENDING", "importStatus": "COMPLETED", "updatedAt": _now()})
        _finalize_work_primary(db, work["id"], edition["id"], cover_path)
        return ImportResult(work["id"], work["id"], edition["id"], volume["id"], work["title"], "ebook", "pdf", metadata["pageCount"], "completed", False, not created, "new-pdf-work" if created else "same-pdf-work")
    except Exception:
        if cover_path:
            Path(cover_path).unlink(missing_ok=True)
        if staged:
            _rollback_staged(options.source_file_path, staged, options.import_mode)
        raise


def _import_comic(db: Session, settings: Settings, options: ImportOptions, task_id: str, file_size: int, ext: str) -> ImportResult:
    parsed = parse_comic_archive(options.source_file_path, options.original_name)
    volume_info = parse_comic_volume_info(parsed, options.source_file_path, options.original_name)
    title = (volume_info or {}).get("seriesName") or (parsed.get("comicInfo") or {}).get("series") or _comic_parent_title(options.source_file_path, options.origin) or parsed["title"]
    author = (volume_info or {}).get("author") or parsed["author"]
    merge_key = _work_merge_key("cbz", title, author)
    source_key = _source_group_key(options, title)
    volume_index = (volume_info or {}).get("seriesIndex")
    volume_title = f"第 {volume_index:g} 卷" if volume_index is not None else ((parsed.get("comicInfo") or {}).get("title") or parsed["title"])
    work, created = _ensure_work(db, {"title": title, "author": author, "description": parsed.get("description"), "workType": "COMIC", "tags": (parsed.get("comicInfo") or {}).get("tags") or ["comic", parsed["format"]], "mergeKey": merge_key, "origin": options.origin, "monitorFolderId": options.monitor_folder_id})
    duplicate = _find_comic_duplicate_volume(db, work["id"], volume_index, volume_title)
    if duplicate:
        return ImportResult(work["id"], work["id"], duplicate["editionId"], duplicate["id"], work["title"], "comic", parsed["format"], duplicate.get("pageCount") or 0, "completed", True, True, "duplicate-comic-metadata")
    edition = _select_comic_edition(db, work["id"], source_key, volume_index, volume_title)
    created_edition = False
    if not edition:
        created_edition = True
        edition = _insert(db, "LibraryEdition", {"id": _id(), "workId": work["id"], "monitorFolderId": options.monitor_folder_id, "origin": options.origin, "format": "COMIC", "versionName": _next_edition_name(db, work["id"], "漫画版本"), "versionKey": f"comic:{source_key}", "sourceGroupKey": source_key, "description": parsed.get("description"), "publisher": (parsed.get("comicInfo") or {}).get("publisher"), "coverStatus": "PENDING", "importStatus": "PARSING", "primary": not bool(work.get("primaryEditionId")), "hidden": False, "createdAt": _now(), "updatedAt": _now()})
    staged = None
    cover_path = None
    try:
        sort_order = int(volume_index * 1000) if volume_index is not None else _table_count(db, "LibraryVolume", "`editionId` = :edition_id", {"edition_id": edition["id"]})
        volume = _insert(db, "LibraryVolume", {"id": _id(), "editionId": edition["id"], "title": volume_title, "volumeIndex": volume_index, "sortOrder": sort_order, "pageCount": parsed["pageCount"], "coverPath": None, "createdAt": _now(), "updatedAt": _now()})
        managed = _managed_path_for(settings, task_id, ext)
        staged = stage_managed_import_file(options.source_file_path, managed, options.import_mode)
        _update(db, "ImportTask", task_id, {"managedFilePath": str(managed), "message": "正在建立漫画记录"})
        file = _insert(db, "LibraryFile", {"id": _id(), "editionId": edition["id"], "volumeId": volume["id"], "path": str(staged), "filePathHash": _hash_text(str(staged)), "hashStatus": "PARTIAL_PENDING", "kind": "COMIC", "mimeType": "application/vnd.comicbook+zip" if parsed["format"] == "cbz" else "application/zip", "sizeBytes": file_size, "mtimeMs": int(staged.stat().st_mtime * 1000), "sortOrder": sort_order, "createdAt": _now(), "updatedAt": _now()})
        cover_path = _extract_comic_cover(settings, staged, work["id"], edition["id"], volume["id"], parsed["coverEntryPath"])
        for page in parsed["pages"]:
            _insert(db, "LibraryReadingUnit", {"id": _id(), "editionId": edition["id"], "volumeId": volume["id"], "fileId": file["id"], "unitType": "page", "title": page["title"], "href": page["entryPath"], "mediaType": page["mediaType"], "sortOrder": page["index"], "size": page.get("size"), "metadataJson": json.dumps({"zipEntryName": page["entryPath"], "originalName": Path(page["entryPath"]).name, "pageInVolume": page["index"], "pageInSection": page["index"], "volumeIndex": volume_index, "sourceFileName": options.original_name or options.source_file_path.name}, ensure_ascii=False), "createdAt": _now(), "updatedAt": _now()})
        _insert(db, "LibraryMetadata", {"id": _id(), "editionId": edition["id"], "source": "comic_info" if parsed.get("comicInfo") else "system", "rawJson": json.dumps({**parsed["rawMetadata"], "volumeIndex": volume_index, "sourceFileName": options.original_name or options.source_file_path.name}, ensure_ascii=False), "createdAt": _now(), "updatedAt": _now()})
        _update(db, "LibraryVolume", volume["id"], {"coverPath": cover_path, "pageCount": parsed["pageCount"], "updatedAt": _now()})
        size_total = _scalar(db, "SELECT COALESCE(SUM(`sizeBytes`), 0) FROM `LibraryFile` WHERE `editionId` = :edition_id", {"edition_id": edition["id"]}, 0)
        page_total = _scalar(db, "SELECT COALESCE(SUM(`pageCount`), 0) FROM `LibraryVolume` WHERE `editionId` = :edition_id", {"edition_id": edition["id"]}, 0)
        _update(db, "LibraryEdition", edition["id"], {"sizeBytes": int(size_total), "pageCount": int(page_total), "coverPath": edition.get("coverPath") or cover_path, "coverStatus": "READY", "importStatus": "COMPLETED", "updatedAt": _now()})
        _finalize_work_primary(db, work["id"], edition["id"], cover_path)
        return ImportResult(work["id"], work["id"], edition["id"], volume["id"], work["title"], "comic", parsed["format"], parsed["pageCount"], "completed", False, (not created) or (not created_edition), "new-comic-work" if created else "new-comic-version" if created_edition else "same-comic-series")
    except Exception:
        if cover_path:
            Path(cover_path).unlink(missing_ok=True)
        if staged:
            _rollback_staged(options.source_file_path, staged, options.import_mode)
        raise


def parse_epub_metadata(path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(path) as archive:
        container = archive.read("META-INF/container.xml").decode("utf-8", "replace")
        match = re.search(r'full-path=["\']([^"\']+)["\']', container)
        if not match:
            raise ValueError("container.xml 缺少 rootfile full-path")
        opf_path = match.group(1)
        opf_xml = archive.read(opf_path).decode("utf-8", "replace")
        title = _first_text(opf_xml, "title") or _title_from_file(path)
        author = _first_text(opf_xml, "creator") or "未知作者"
        identifiers = _texts(opf_xml, "identifier")
        manifest = _opf_items(opf_xml)
        spine = _opf_itemrefs(opf_xml)
        chapters = _epub_chapters(archive, opf_path, opf_xml, manifest, spine)
        cover = _epub_cover(manifest, opf_xml)
        raw_metadata = {
            "opfPath": opf_path,
            "dc:title": _texts(opf_xml, "title"),
            "dc:creator": _texts(opf_xml, "creator"),
            "dc:identifier": identifiers,
            "dc:language": _texts(opf_xml, "language"),
            "dc:publisher": _texts(opf_xml, "publisher"),
            "dc:date": _texts(opf_xml, "date"),
            "dc:description": _texts(opf_xml, "description"),
            "dc:subject": _texts(opf_xml, "subject"),
            "meta": _attrs(opf_xml, "meta"),
        }
        return {
            "title": title,
            "author": author,
            "language": _first_text(opf_xml, "language"),
            "identifier": identifiers[0] if identifiers else None,
            "isbn": _extract_isbn(identifiers),
            "publisher": _first_text(opf_xml, "publisher"),
            "publishedAt": _first_text(opf_xml, "date"),
            "description": _sanitize_description(_first_text(opf_xml, "description")),
            "subjects": _texts(opf_xml, "subject"),
            "coverPath": cover.get("href") if cover else None,
            "coverMediaType": cover.get("mediaType") if cover else None,
            "chapterCount": len(chapters),
            "chapters": chapters,
            "opfPath": opf_path,
            "rawMetadata": raw_metadata,
        }


def parse_comic_archive(path: Path, original_name: str | None = None) -> dict[str, Any]:
    fmt = "cbz" if path.suffix.lower() == ".cbz" else "zip"
    with zipfile.ZipFile(path) as archive:
        entries = [info for info in archive.infolist() if not info.is_dir() and _safe_entry_name(info.filename)]
        images = [info for info in entries if Path(info.filename).suffix.lower() in IMAGE_EXTS and not _ignored_entry(info.filename)]
        if not images:
            raise ValueError("漫画压缩包内没有可导入的图片")
        images.sort(key=lambda item: _natural_key(item.filename))
        comic_info_entry = next((info for info in entries if info.filename.lower().endswith("comicinfo.xml")), None)
        comic_info = _parse_comic_info(archive.read(comic_info_entry).decode("utf-8", "replace")) if comic_info_entry else None
        pages = [{"index": index + 1, "title": f"第 {index + 1} 页", "entryPath": info.filename, "mediaType": mimetypes.guess_type(info.filename)[0] or "application/octet-stream", "size": info.file_size} for index, info in enumerate(images)]
        cover_index = (comic_info or {}).get("coverImageIndex")
        cover = pages[cover_index] if isinstance(cover_index, int) and 0 <= cover_index < len(pages) else next((page for page in pages if re.search(r"(cover|folder|front|封面)", Path(page["entryPath"]).name, re.I)), pages[0])
        image_formats = sorted({Path(page["entryPath"]).suffix.lower().lstrip(".") for page in pages})
        raw_metadata = {"hasComicInfo": comic_info is not None, "pageCount": len(pages), "imageFormats": image_formats, "coverEntryPath": cover["entryPath"]}
        if comic_info:
            raw_metadata["comicInfo"] = comic_info.get("raw") or {}
        return {"title": (comic_info or {}).get("title") or _title_from_file(Path(original_name or path.name)), "author": (comic_info or {}).get("writer") or (comic_info or {}).get("penciller") or "未知作者", "description": (comic_info or {}).get("summary"), "format": fmt, "pageCount": len(pages), "coverEntryPath": cover["entryPath"], "pages": pages, "comicInfo": comic_info, "rawMetadata": raw_metadata}


def parse_pdf_metadata(path: Path, original_name: str | None = None) -> dict[str, Any]:
    title = _title_from_file(Path(original_name or path.name))
    author = "未知作者"
    page_count = 1
    raw_metadata: dict[str, Any] = {"sourceFileName": original_name or path.name}
    try:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(str(path))
        try:
            page_count = max(1, len(pdf))
            doc_info = pdf.get_metadata_dict()
            raw_metadata.update(doc_info or {})
            title = str(doc_info.get("Title") or title).strip() or title
            author = str(doc_info.get("Author") or author).strip() or author
        finally:
            pdf.close()
    except Exception as exc:
        raw_metadata["parseWarning"] = str(exc)
        page_count = max(1, _fallback_pdf_page_count(path))
    raw_metadata.update(_pdf_inline_metadata(path))
    title = str(raw_metadata.get("Title") or title).strip() or title
    author = str(raw_metadata.get("Author") or author).strip() or author
    description = _sanitize_description(str(raw_metadata.get("Subject") or "").strip())
    tags = _split_tags(str(raw_metadata.get("Keywords") or ""))
    return {"title": title, "author": author, "description": description, "tags": tags, "pageCount": page_count, "rawMetadata": raw_metadata}


def _pdf_inline_metadata(path: Path) -> dict[str, str]:
    try:
        content = path.read_bytes()
    except OSError:
        return {}
    metadata: dict[str, str] = {}
    for key in ["Title", "Author", "Subject", "Keywords"]:
        match = re.search(rb"/" + key.encode("ascii") + rb"\s*\(([^()]*)\)", content, re.S)
        if not match:
            continue
        value = _decode_pdf_literal(match.group(1))
        if value:
            metadata[key] = value
    return metadata


def _decode_pdf_literal(value: bytes) -> str:
    text = value.decode("utf-8", "replace")
    replacements = {
        r"\(": "(",
        r"\)": ")",
        r"\\": "\\",
        r"\n": "\n",
        r"\r": "\r",
        r"\t": "\t",
        r"\b": "\b",
        r"\f": "\f",
    }
    for escaped, replacement in replacements.items():
        text = text.replace(escaped, replacement)
    return text.strip()


def _fallback_pdf_page_count(path: Path) -> int:
    try:
        content = path.read_bytes()
    except OSError:
        return 1
    matches = re.findall(rb"/Type\s*/Page\b", content)
    return len(matches) or 1


def parse_comic_volume_from_name(path: Path, original_name: str | None = None) -> dict[str, Any] | None:
    source = original_name or path.name
    base = Path(source).stem
    parent = _comic_parent_title(path, "WATCH")
    for pattern in [r"^(?:vol\.?|volume)\s*(\d+(?:\.\d+)?)$", r"^v\s*(\d+(?:\.\d+)?)$", r"^(?:第\s*)?(\d+(?:\.\d+)?)\s*(?:卷|冊|册|集)$"]:
        match = re.match(pattern, base.strip(), re.I)
        if match and parent:
            index = float(match.group(1))
            author = _comic_parent_author(path)
            result = {"seriesName": parent, "seriesIndex": index, "title": f"{parent} ({index:g})"}
            if author:
                result["author"] = author
            return result
    for pattern in [r"^(.+?)\s*[\(（［\[]\s*(\d+(?:\.\d+)?)\s*[\)）］\]]\s*$", r"^(.+?)\s*(?:第\s*)?(\d+(?:\.\d+)?)\s*(?:卷|冊|册|集)\s*$", r"^(.+?)\s*(?:vol\.?|volume)\s*(\d+(?:\.\d+)?)\s*$", r"^(.+?)\s+v(\d+(?:\.\d+)?)\s*$"]:
        match = re.match(pattern, base, re.I)
        if match:
            series = _clean_title_part(match.group(1))
            index = float(match.group(2))
            if series:
                return {"seriesName": series, "seriesIndex": index, "title": f"{series} ({index:g})"}
    return None


def parse_comic_volume_info(parsed: dict[str, Any], path: Path, original_name: str | None = None) -> dict[str, Any] | None:
    comic_info = parsed.get("comicInfo") if isinstance(parsed.get("comicInfo"), dict) else {}
    if comic_info.get("series") and comic_info.get("volume") is not None:
        return {
            "seriesName": comic_info["series"],
            "seriesIndex": comic_info["volume"],
            "title": f"{comic_info['series']} ({comic_info['volume']:g})",
        }
    return parse_comic_volume_from_name(path, original_name)


def stage_managed_import_file(source: Path, managed: Path, import_mode: str = "COPY") -> Path:
    managed.parent.mkdir(parents=True, exist_ok=True)
    if import_mode == "MOVE":
        try:
            source.rename(managed)
        except OSError:
            shutil.copy2(source, managed)
            try:
                source.unlink()
            except OSError as exc:
                managed.unlink(missing_ok=True)
                raise RuntimeError("移动模式需要删除监控目录中的源文件，但当前监控目录不可写或以只读方式挂载；请改用复制模式，或将 /monitor 挂载为可写。") from exc
    else:
        shutil.copy2(source, managed)
    return managed


def _rollback_staged(source: Path, managed: Path, import_mode: str) -> None:
    if import_mode == "MOVE" and managed.exists() and not source.exists():
        try:
            managed.rename(source)
        except OSError:
            shutil.copy2(managed, source)
            managed.unlink()
    elif import_mode != "MOVE":
        managed.unlink(missing_ok=True)


def _ensure_import_task(db: Session, options: ImportOptions) -> str:
    row = _insert(db, "ImportTask", {"id": _id(), "monitorFolderId": options.monitor_folder_id, "origin": options.origin, "status": "PENDING", "originalName": options.original_name or options.source_file_path.name, "sourcePath": str(options.source_file_path), "progress": 0, "duplicate": False, "duration": 0, "message": "等待导入", "createdAt": _now(), "updatedAt": _now()})
    return row["id"]


def _ensure_work(db: Session, data: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    existing = _row(db, "SELECT * FROM `LibraryWork` WHERE `mergeKey` = :merge_key", {"merge_key": data["mergeKey"]})
    if existing:
        _update(db, "LibraryWork", existing["id"], {"hidden": False, "updatedAt": _now()})
        return _row(db, "SELECT * FROM `LibraryWork` WHERE `id` = :id", {"id": existing["id"]}) or existing, False
    row = _insert(db, "LibraryWork", {"id": _id(), "monitorFolderId": data.get("monitorFolderId"), "origin": data["origin"], "title": data["title"], "normalizedTitle": _normalize_key(data["title"]), "author": data["author"], "normalizedAuthor": _normalize_key(data["author"]), "description": data.get("description"), "workType": data["workType"], "status": "WANT", "publicationStatus": "UNKNOWN", "trackingStatus": "NOT_TRACKING", "tags": json.dumps(data["tags"], ensure_ascii=False), "metadataQuality": 0, "organizeStatus": "REVIEWING", "coverStatus": "PENDING", "hidden": False, "organized": False, "mergeKey": data["mergeKey"], "createdAt": _now(), "updatedAt": _now()})
    return row, True


def _create_or_refresh_organize_job(db: Session, work_id: str, edition_id: str, task_id: str) -> None:
    existing = _row(db, "SELECT * FROM `OrganizeJob` WHERE `workId` = :work_id AND `editionId` = :edition_id", {"work_id": work_id, "edition_id": edition_id})
    if existing:
        _update(db, "OrganizeJob", existing["id"], {"status": "REVIEWING", "updatedAt": _now()})
        return
    _insert(db, "OrganizeJob", {"id": _id(), "workId": work_id, "editionId": edition_id, "importTaskId": task_id, "status": "REVIEWING", "issueCodes": "[]", "summary": "Python worker import metadata review", "createdAt": _now(), "updatedAt": _now()})


def _auto_apply_epub_metadata(db: Session, work_id: str, edition_id: str, task_id: str) -> bool:
    if not all(_has_table(db, table) for table in ["LibraryWork", "OrganizeJob", "MetadataSuggestion"]):
        return False
    job = _row(db, "SELECT * FROM `OrganizeJob` WHERE `workId` = :work_id AND `editionId` = :edition_id ORDER BY `updatedAt` DESC LIMIT 1", {"work_id": work_id, "edition_id": edition_id})
    if not job:
        return False
    work = _row(db, "SELECT * FROM `LibraryWork` WHERE `id` = :work_id", {"work_id": work_id})
    match_title = str((work or {}).get("title") or "").strip()
    if metadata_title_needs_ai(match_title):
        ai_title = _ai_title_for_metadata(db, job["id"], task_id)
        if not ai_title:
            return False
        match_title = ai_title
    for provider in ["douban", "bangumi"]:
        try:
            result = refresh_metadata_providers(db, job["id"], [provider], force=True, query=match_title, match_title=match_title)
        except Exception:
            continue
        if int(result.get("added") or 0) <= 0:
            continue
        suggestion_ids = [
            item["id"]
            for item in _rows(
                db,
                "SELECT `id` FROM `MetadataSuggestion` WHERE `jobId` = :job_id AND `status` = 'PENDING' AND `source` = :source ORDER BY `confidence` DESC, `createdAt` ASC",
                {"job_id": job["id"], "source": provider},
            )
        ]
        if not suggestion_ids:
            continue
        apply_organize_job(db, job["id"], {"suggestionIds": suggestion_ids, "markOrganized": True})
        _log_import(db, task_id, "info", f"auto metadata applied from {provider}")
        return True
    return False


def _ai_title_for_metadata(db: Session, job_id: str, task_id: str) -> str | None:
    try:
        refresh_metadata_providers(db, job_id, ["ai"], force=True)
    except Exception as exc:
        _log_import(db, task_id, "warning", f"ai title recognition failed: {exc}")
        return None
    suggestion = _row(
        db,
        "SELECT `suggestedValue` FROM `MetadataSuggestion` WHERE `jobId` = :job_id AND `status` = 'PENDING' AND `source` = 'ai' AND `field` = 'title' ORDER BY `confidence` DESC, `createdAt` ASC LIMIT 1",
        {"job_id": job_id},
    )
    value = parse_json_value((suggestion or {}).get("suggestedValue"))
    title = str(value or "").strip()
    if not title or metadata_title_needs_ai(title):
        return None
    _log_import(db, task_id, "info", f"ai metadata title recognized: {title}")
    return title


def _insert(db: Session, table: str, values: dict[str, Any]) -> dict[str, Any]:
    columns = _columns(db, table)
    filtered = {key: value for key, value in values.items() if key in columns}
    keys = ", ".join(f"`{key}`" for key in filtered)
    params = ", ".join(f":{key}" for key in filtered)
    db.execute(text(f"INSERT INTO `{table}` ({keys}) VALUES ({params})"), filtered)
    db.commit()
    return _row(db, f"SELECT * FROM `{table}` WHERE `id` = :id", {"id": filtered["id"]}) or filtered


def _update(db: Session, table: str, row_id: str, values: dict[str, Any]) -> None:
    columns = _columns(db, table)
    filtered = {key: value for key, value in values.items() if key in columns}
    if not filtered:
        return
    filtered["row_id"] = row_id
    assignments = ", ".join(f"`{key}` = :{key}" for key in filtered if key != "row_id")
    db.execute(text(f"UPDATE `{table}` SET {assignments} WHERE `id` = :row_id"), filtered)
    db.commit()


def _row(db: Session, sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
    result = db.execute(text(sql), params or {}).mappings().first()
    return dict(result) if result else None


def _scalar(db: Session, sql: str, params: dict[str, Any] | None = None, default: Any = None) -> Any:
    value = db.execute(text(sql), params or {}).scalar()
    return default if value is None else value


def _table_count(db: Session, table: str, where: str = "", params: dict[str, Any] | None = None) -> int:
    suffix = f" WHERE {where}" if where else ""
    return int(_scalar(db, f"SELECT COUNT(*) FROM `{table}`{suffix}", params, 0))


def _columns(db: Session, table: str) -> set[str]:
    return {column["name"] for column in inspect(db.get_bind()).get_columns(table)}


def _has_table(db: Session, table: str) -> bool:
    return table in inspect(db.get_bind()).get_table_names()


def _id() -> str:
    return f"py_{time.time_ns()}"


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _content_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _hash_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _managed_path_for(settings: Settings, task_id: str, ext: str) -> Path:
    directory = settings.resolved_storage_root / "library" / task_id[:2]
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{task_id}-{time.time_ns()}{ext}"


def _log_import(db: Session, task_id: str | None, level: str, message: str) -> None:
    if task_id and "ImportLog" in inspect(db.get_bind()).get_table_names():
        _insert(db, "ImportLog", {"id": _id(), "importTaskId": task_id, "level": level, "message": message, "createdAt": _now()})


def _normalize_key(value: Any) -> str:
    return re.sub(r"[\s_\-.[\]()（）【】《》:：,，!！?？]+", "", str(value or "").lower()).strip()


def _work_merge_key(fmt: str, title: str, author: str | None = None, identifier: str | None = None, isbn: str | None = None) -> str:
    if isbn:
        return f"isbn:{_normalize_key(isbn)}"
    if identifier:
        return f"id:{_normalize_key(identifier)}"
    prefix = fmt if fmt in {"epub", "pdf"} else "comic"
    return f"{prefix}:{_normalize_key(title)}:{_normalize_key(author)}"


def _source_group_key(options: ImportOptions, fallback_title: str) -> str:
    if options.origin == "WATCH":
        return f"watch:{_normalize_key(str(options.source_file_path.resolve().parent))}"
    return f"manual:{_normalize_key(fallback_title)}"


def _next_edition_name(db: Session, work_id: str, base: str) -> str:
    count = _table_count(db, "LibraryEdition", "`workId` = :work_id", {"work_id": work_id})
    return base if count == 0 else f"{base} {count + 1}"


def _finalize_work_primary(db: Session, work_id: str, edition_id: str, cover_path: str | None) -> None:
    work = _row(db, "SELECT * FROM `LibraryWork` WHERE `id` = :id", {"id": work_id})
    if not work:
        return
    _update(db, "LibraryWork", work_id, {"primaryEditionId": work.get("primaryEditionId") or edition_id, "coverPath": work.get("coverPath") or cover_path, "coverStatus": "READY" if (work.get("coverPath") or cover_path) else work.get("coverStatus"), "updatedAt": _now()})


def _find_comic_duplicate_volume(db: Session, work_id: str, volume_index: float | None, volume_title: str) -> dict[str, Any] | None:
    volumes = _rows(db, "SELECT v.* FROM `LibraryVolume` v JOIN `LibraryEdition` e ON e.`id` = v.`editionId` WHERE e.`workId` = :work_id AND e.`format` = 'COMIC' AND e.`hidden` = 0", {"work_id": work_id})
    for volume in volumes:
        if volume_index is not None and volume.get("volumeIndex") == volume_index:
            return volume
        if volume_index is None and _normalize_key(volume.get("title")) == _normalize_key(volume_title):
            return volume
    return None


def _select_comic_edition(db: Session, work_id: str, source_key: str, volume_index: float | None, volume_title: str) -> dict[str, Any] | None:
    editions = _rows(db, "SELECT * FROM `LibraryEdition` WHERE `workId` = :work_id AND `format` = 'COMIC' AND `hidden` = 0 ORDER BY `createdAt` ASC", {"work_id": work_id})
    for edition in editions:
        conflict = _find_comic_duplicate_volume(db, work_id, volume_index, volume_title)
        if not conflict and edition.get("sourceGroupKey") == source_key:
            return edition
    return editions[0] if editions and not _find_comic_duplicate_volume(db, work_id, volume_index, volume_title) else None


def _rows(db: Session, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    return [dict(row) for row in db.execute(text(sql), params or {}).mappings().all()]


def _first_text(xml: str, tag: str) -> str | None:
    values = _texts(xml, tag)
    return values[0] if values else None


def _texts(xml: str, tag: str) -> list[str]:
    values = []
    for match in re.finditer(rf"<(?:[\w]+:)?{re.escape(tag)}\b[^>]*>([\s\S]*?)</(?:[\w]+:)?{re.escape(tag)}>", xml, re.I):
        text_value = _decode_xml_text(match.group(1))
        if text_value:
            values.append(text_value)
    return values


def _decode_xml_text(value: str) -> str:
    value = re.sub(r"<!\[CDATA\[([\s\S]*?)\]\]>", r"\1", value)
    value = re.sub(r"<[^>]+>", " ", value)
    try:
        value = ElementTree.fromstring(f"<x>{value}</x>").text or value
    except ElementTree.ParseError:
        pass
    return re.sub(r"\s+", " ", value).strip()


def _attrs(xml: str, name: str) -> list[dict[str, str]]:
    output = []
    for match in re.finditer(rf"<{name}\b([^>]*)/?>(?:</{name}>)?", xml, re.I):
        output.append({item.group(1): item.group(2) or item.group(3) or "" for item in re.finditer(r"""([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')""", match.group(1))})
    return output


def _opf_items(opf_xml: str) -> list[dict[str, str]]:
    return [{"id": attrs.get("id"), "href": attrs.get("href"), "mediaType": attrs.get("media-type"), "properties": attrs.get("properties")} for attrs in _attrs(opf_xml, "item")]


def _opf_itemrefs(opf_xml: str) -> list[dict[str, str]]:
    return [{"idref": attrs.get("idref")} for attrs in _attrs(opf_xml, "itemref")]


def _epub_chapters(archive: zipfile.ZipFile, opf_path: str, opf_xml: str, manifest: list[dict[str, str]], spine: list[dict[str, str]]) -> list[dict[str, Any]]:
    href_items = {_normalize_epub_path(item.get("href") or ""): item for item in manifest if item.get("href")}
    spine_attrs = _attrs(opf_xml, "spine")
    ncx_id = (spine_attrs[0] if spine_attrs else {}).get("toc")
    ncx = next((item for item in manifest if item.get("id") == ncx_id), None) or next((item for item in manifest if "ncx" in str(item.get("mediaType") or "").lower()), None)
    if ncx and ncx.get("href"):
        chapters = _parse_ncx(_read_zip_text_optional(archive, _epub_zip_path(opf_path, ncx["href"])), opf_path, _epub_zip_path(opf_path, ncx["href"]), href_items)
        if chapters:
            return chapters
    nav = next((item for item in manifest if "nav" in str(item.get("properties") or "").split()), None)
    if nav and nav.get("href"):
        chapters = _parse_nav(_read_zip_text_optional(archive, _epub_zip_path(opf_path, nav["href"])), opf_path, _epub_zip_path(opf_path, nav["href"]), href_items)
        if chapters:
            return chapters
    chapters = []
    by_id = {item.get("id"): item for item in manifest}
    for index, ref in enumerate(spine, start=1):
        item = by_id.get(ref.get("idref"))
        if item and item.get("href"):
            title = _chapter_heading(archive, opf_path, item["href"]) or f"第 {index} 章"
            chapters.append({"title": title, "href": item["href"], "idref": ref.get("idref"), "mediaType": item.get("mediaType"), "sortOrder": index})
    return chapters


def _parse_ncx(xml: str | None, opf_path: str, ncx_path: str, href_items: dict[str, dict[str, str]]) -> list[dict[str, Any]]:
    if not xml:
        return []
    entries = []
    for index, block in enumerate(re.findall(r"<navPoint\b[\s\S]*?</navPoint>", xml, re.I), start=1):
        title = _first_text(block, "text") or ""
        src = (_attrs(block, "content")[0] if _attrs(block, "content") else {}).get("src", "")
        chapter = _chapter_from_toc(title, src, index, opf_path, ncx_path, href_items)
        if chapter:
            entries.append(chapter)
    return entries


def _parse_nav(xml: str | None, opf_path: str, nav_path: str, href_items: dict[str, dict[str, str]]) -> list[dict[str, Any]]:
    if not xml:
        return []
    entries = []
    nav_blocks = list(re.finditer(r"<nav\b([^>]*)>([\s\S]*?)</nav>", xml, re.I))
    toc_block = next(
        (
            match.group(2)
            for match in nav_blocks
            if re.search(r"\b(?:epub:)?type\s*=\s*['\"][^'\"]*\btoc\b", match.group(1), re.I) or re.search(r"\brole\s*=\s*['\"]doc-toc['\"]", match.group(1), re.I)
        ),
        nav_blocks[0].group(2) if nav_blocks else xml,
    )
    for index, match in enumerate(re.finditer(r"<a\b([^>]*)>([\s\S]*?)</a>", toc_block, re.I), start=1):
        title = _decode_xml_text(match.group(2))
        href = (_attrs(f"<a{match.group(1)}>", "a")[0] if _attrs(f"<a{match.group(1)}>", "a") else {}).get("href", "")
        chapter = _chapter_from_toc(title, href, index, opf_path, nav_path, href_items)
        if chapter:
            entries.append(chapter)
    return entries


def _chapter_from_toc(title: str, href: str, index: int, opf_path: str, toc_path: str, href_items: dict[str, dict[str, str]]) -> dict[str, Any] | None:
    if not title or not href:
        return None
    path_part, _, fragment = href.partition("#")
    absolute = _normalize_epub_path(str(PurePosixPath(toc_path).parent / path_part))
    relative = _normalize_epub_path(os.path.relpath(absolute, str(PurePosixPath(opf_path).parent)).replace("\\", "/"))
    full_href = f"{relative}#{fragment}" if fragment else relative
    item = href_items.get(_normalize_epub_path(relative))
    return {"title": title, "href": full_href, "idref": item.get("id") if item else None, "mediaType": item.get("mediaType") if item else None, "sortOrder": index}


def _chapter_heading(archive: zipfile.ZipFile, opf_path: str, href: str) -> str | None:
    markup = _read_zip_text_optional(archive, _epub_zip_path(opf_path, href))
    if not markup:
        return None
    for tag in ["h1", "h2", "h3", "title"]:
        value = _first_text(markup, tag)
        if value:
            return value
    return None


def _epub_cover(manifest: list[dict[str, str]], opf_xml: str) -> dict[str, str] | None:
    meta_cover = next((attrs.get("content") for attrs in _attrs(opf_xml, "meta") if attrs.get("name") == "cover"), None)
    return next((item for item in manifest if item.get("id") == meta_cover), None) or next((item for item in manifest if "cover-image" in str(item.get("properties") or "")), None) or next((item for item in manifest if "image" in str(item.get("mediaType") or "") and re.search(r"(cover|front|folder|封面)", str(item.get("href") or ""), re.I)), None)


def _epub_zip_path(opf_path: str, href: str) -> str:
    path = href.split("#", 1)[0]
    return _normalize_epub_path(str(PurePosixPath(opf_path).parent / path))


def _normalize_epub_path(value: str) -> str:
    return str(PurePosixPath(value.replace("\\", "/"))).lstrip("./")


def _read_zip_text_optional(archive: zipfile.ZipFile, entry: str) -> str | None:
    try:
        return archive.read(entry).decode("utf-8", "replace")
    except KeyError:
        return None


def _extract_epub_cover(settings: Settings, staged: Path, work_id: str, edition_id: str, metadata: dict[str, Any]) -> str | None:
    if not metadata.get("coverPath"):
        return None
    rel = _epub_zip_path(metadata["opfPath"], metadata["coverPath"])
    ext = Path(metadata["coverPath"]).suffix or ".jpg"
    target = settings.resolved_storage_root / "books" / work_id / edition_id / f"cover{ext}"
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(staged) as archive:
        target.write_bytes(archive.read(rel))
    return str(target)


def _extract_comic_cover(settings: Settings, staged: Path, work_id: str, edition_id: str, volume_id: str, entry: str) -> str:
    ext = Path(entry).suffix.lower() or ".jpg"
    target = settings.resolved_storage_root / "books" / work_id / edition_id / volume_id / f"cover{ext}"
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(staged) as archive:
        target.write_bytes(archive.read(entry))
    return str(target)


def _extract_pdf_cover(settings: Settings, staged: Path, work_id: str, edition_id: str, metadata: dict[str, Any]) -> str | None:
    target = settings.resolved_storage_root / "books" / work_id / edition_id / "cover.jpg"
    try:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(str(staged))
        try:
            if len(pdf) < 1:
                return None
            page = pdf[0]
            bitmap = page.render(scale=2)
            image = bitmap.to_pil()
            if image.mode not in {"RGB", "L"}:
                image = image.convert("RGB")
            image.thumbnail((900, 1200))
            target.parent.mkdir(parents=True, exist_ok=True)
            image.save(target, format="JPEG", quality=88, optimize=True)
            metadata["rawMetadata"]["coverRenderedFromPage"] = 1
            return str(target)
        finally:
            pdf.close()
    except Exception as exc:
        metadata["rawMetadata"]["coverWarning"] = str(exc)
        target.unlink(missing_ok=True)
        return None


def _extract_isbn(ids: list[str]) -> str | None:
    for value in ids:
        match = re.search(r"(?:97[89])?[0-9]{9}[0-9Xx]", re.sub(r"[^0-9Xx]", "", value))
        if match:
            return match.group(0).upper()
    return None


def _sanitize_description(value: str | None) -> str | None:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value)).strip() if value else None


def _title_from_file(path: Path) -> str:
    return re.sub(r"[_-]+", " ", Path(path).stem).strip() or Path(path).name


def _safe_entry_name(name: str) -> bool:
    normalized = str(PurePosixPath(name.replace("\\", "/")))
    return bool(name and not name.startswith("/") and not re.match(r"^[a-zA-Z]:", name) and not normalized.startswith("../") and "/../" not in normalized)


def _ignored_entry(name: str) -> bool:
    parts = name.split("/")
    last = parts[-1]
    return "__MACOSX" in parts or last in {".DS_Store", "Thumbs.db"} or last.startswith("._") or any(part.startswith(".") for part in parts)


def _natural_key(value: str) -> list[Any]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value)]


def _parse_comic_info(xml: str) -> dict[str, Any]:
    raw = {}
    for tag in ["Title", "Series", "Volume", "Summary", "Writer", "Penciller", "Publisher", "Genre", "Tags"]:
        value = _first_text(xml, tag)
        if value:
            raw[tag] = value
    volume = float(raw["Volume"]) if str(raw.get("Volume", "")).replace(".", "", 1).isdigit() else None
    cover_match = re.search(r"<Page\b[^>]*(?:Type|type)=['\"](?:FrontCover|Cover)['\"][^>]*(?:Image|image)=['\"](\d+)['\"]", xml, re.I)
    return {"title": raw.get("Title"), "series": raw.get("Series"), "volume": volume, "summary": raw.get("Summary"), "writer": raw.get("Writer"), "penciller": raw.get("Penciller"), "publisher": raw.get("Publisher"), "tags": _split_tags(raw.get("Tags") or raw.get("Genre")), "coverImageIndex": int(cover_match.group(1)) if cover_match else None, "raw": raw}


def _split_tags(value: str | None) -> list[str]:
    return [tag.strip() for tag in re.split(r"[,，;]", value or "") if tag.strip()]


def _clean_title_part(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("_", " ").replace("-", " ")).strip()


def _bracketed_folder_metadata(value: str) -> dict[str, str] | None:
    parts = [_clean_title_part(match.group(1)) for match in re.finditer(r"\[([^\]]+)\]", value)]
    if len(parts) == 2 and "".join(parts) and "".join(parts) == value.replace(" ", "").replace("[", "").replace("]", ""):
        return {"title": parts[0], "author": parts[1]}
    return None


def _comic_parent_title(path: Path, origin: str) -> str | None:
    if origin != "WATCH":
        return None
    parent = _clean_title_part(path.parent.name)
    if not parent or parent.lower() in {".", "/", "books", "library", "comics", "comic", "manga", "漫画"}:
        return None
    return (_bracketed_folder_metadata(parent) or {}).get("title") or parent


def _comic_parent_author(path: Path) -> str | None:
    parent = _clean_title_part(path.parent.name)
    return (_bracketed_folder_metadata(parent) or {}).get("author")
