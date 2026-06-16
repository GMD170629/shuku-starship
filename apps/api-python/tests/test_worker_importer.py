import json
import zipfile
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

from sqlalchemy import text

from app.worker.importer import ImportOptions, _work_merge_key, import_managed_book, parse_comic_volume_from_name, parse_epub_metadata, parse_pdf_metadata, parse_series_volume_info, stage_managed_import_file
from app.worker.path_security import PathSecurityError, PathSecurityService, normalize_configured_path
from app.worker.watcher import MonitorFolderConfig, should_ignore_file


def create_worker_tables(db):
    statements = [
        """CREATE TABLE LibraryWork (
            id TEXT PRIMARY KEY, monitorFolderId TEXT, origin TEXT, title TEXT, normalizedTitle TEXT, author TEXT,
            normalizedAuthor TEXT, description TEXT, workType TEXT, status TEXT, publicationStatus TEXT,
            trackingStatus TEXT, tags TEXT, metadataQuality INTEGER, organizeStatus TEXT, coverPath TEXT,
            coverStatus TEXT, hidden BOOLEAN, organized BOOLEAN, primaryEditionId TEXT, mergeKey TEXT UNIQUE,
            createdAt TEXT, updatedAt TEXT
        )""",
        """CREATE TABLE LibraryEdition (
            id TEXT PRIMARY KEY, workId TEXT, monitorFolderId TEXT, origin TEXT, format TEXT, versionName TEXT,
            versionKey TEXT, sourceGroupKey TEXT, description TEXT, language TEXT, publisher TEXT, publishedAt TEXT,
            identifier TEXT, isbn TEXT, importStatus TEXT, importError TEXT, sizeBytes INTEGER DEFAULT 0,
            pageCount INTEGER, chapterCount INTEGER, coverPath TEXT, coverStatus TEXT, "primary" BOOLEAN,
            hidden BOOLEAN, createdAt TEXT, updatedAt TEXT
        )""",
        """CREATE TABLE LibraryVolume (
            id TEXT PRIMARY KEY, editionId TEXT, title TEXT, volumeIndex REAL, sortOrder INTEGER,
            pageCount INTEGER, chapterCount INTEGER, coverPath TEXT, createdAt TEXT, updatedAt TEXT
        )""",
        """CREATE TABLE LibraryFile (
            id TEXT PRIMARY KEY, editionId TEXT, volumeId TEXT, path TEXT, filePathHash TEXT, fingerprint TEXT,
            fullHash TEXT, hashStatus TEXT, mtimeMs INTEGER, kind TEXT, mimeType TEXT, sizeBytes INTEGER,
            sortOrder INTEGER, createdAt TEXT, updatedAt TEXT
        )""",
        """CREATE TABLE LibraryReadingUnit (
            id TEXT PRIMARY KEY, editionId TEXT, volumeId TEXT, fileId TEXT, unitType TEXT, title TEXT, href TEXT,
            mediaType TEXT, sortOrder INTEGER, width INTEGER, height INTEGER, size INTEGER, metadataJson TEXT,
            createdAt TEXT, updatedAt TEXT
        )""",
        """CREATE TABLE LibraryMetadata (
            id TEXT PRIMARY KEY, editionId TEXT, source TEXT, rawJson TEXT, createdAt TEXT, updatedAt TEXT
        )""",
        """CREATE TABLE ImportTask (
            id TEXT PRIMARY KEY, monitorFolderId TEXT, workId TEXT, editionId TEXT, volumeId TEXT, origin TEXT,
            status TEXT, originalName TEXT, sourcePath TEXT, managedFilePath TEXT, contentHash TEXT,
            progress INTEGER, duplicate BOOLEAN, duration INTEGER, errorSummary TEXT, message TEXT,
            startedAt TEXT, finishedAt TEXT, createdAt TEXT, updatedAt TEXT
        )""",
        """CREATE TABLE ImportLog (
            id TEXT PRIMARY KEY, importTaskId TEXT, level TEXT, message TEXT, createdAt TEXT
        )""",
        """CREATE TABLE OrganizeJob (
            id TEXT PRIMARY KEY, workId TEXT, editionId TEXT, importTaskId TEXT, status TEXT, issueCodes TEXT,
            summary TEXT, errorSummary TEXT, createdAt TEXT, updatedAt TEXT
        )""",
    ]
    for statement in statements:
        db.execute(text(statement))
    db.commit()


def create_metadata_provider_tables(db):
    db.execute(
        text(
            """CREATE TABLE MetadataSuggestion (
                id TEXT PRIMARY KEY, jobId TEXT, field TEXT, currentValue TEXT, suggestedValue TEXT,
                source TEXT, confidence REAL, reason TEXT, status TEXT, createdAt TEXT, updatedAt TEXT
            )"""
        )
    )
    db.execute(text("CREATE TABLE IF NOT EXISTS SystemSetting (`key` TEXT PRIMARY KEY, `value` TEXT, `createdAt` TEXT, `updatedAt` TEXT)"))
    db.commit()


def set_system_setting(db, key: str, value: str):
    db.execute(text("INSERT INTO SystemSetting (`key`, `value`, `createdAt`, `updatedAt`) VALUES (:key, :value, 'now', 'now')"), {"key": key, "value": value})
    db.commit()


def serve_import_metadata_gateways():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def json_response(self, payload):
            encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            requests.append({"method": "GET", "path": self.path})
            if self.path.startswith("/v2/book/search") or self.path.startswith("/v2/book/isbn/"):
                self.json_response({"books": []})
                return
            self.send_response(404)
            self.end_headers()

        def do_POST(self):
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            requests.append({"method": "POST", "path": self.path, "body": body})
            if self.path == "/v0/search/subjects":
                self.json_response(
                    {
                        "data": [
                            {
                                "id": 99,
                                "name": "Starship Novel",
                                "name_cn": "目录测试",
                                "summary": "Bangumi fallback description",
                                "date": "2024-04-01",
                                "tags": [{"name": "科幻"}, {"name": "小说"}],
                                "infobox": [
                                    {"key": "作者", "value": "Bangumi 作者"},
                                    {"key": "出版社", "value": "Bangumi 出版社"},
                                    {"key": "册数", "value": "2"},
                                ],
                            }
                        ]
                    }
                )
                return
            self.send_response(404)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    server.requests = requests
    return server


def _count(db, table):
    return db.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar()


def write_epub_fixture(path: Path):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>""",
        )
        archive.writestr(
            "OEBPS/content.opf",
            """<?xml version="1.0"?><package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>目录测试</dc:title><dc:creator>测试作者</dc:creator><dc:subject>fiction</dc:subject>
            </metadata><manifest>
            <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
            <item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/>
            <item id="c2" href="two.xhtml" media-type="application/xhtml+xml"/>
            <item id="cover" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>
            </manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>""",
        )
        archive.writestr("OEBPS/nav.xhtml", '<html><body><nav epub:type="toc"><a href="one.xhtml">第一节</a><a href="two.xhtml">第二节</a></nav></body></html>')
        archive.writestr("OEBPS/one.xhtml", "<html><body><h1>fallback</h1></body></html>")
        archive.writestr("OEBPS/two.xhtml", "<html><body><h1>fallback</h1></body></html>")
        archive.writestr("OEBPS/cover.jpg", b"fake-jpeg")


def write_epub_metadata_fixture(path: Path, title: str, author: str, identifiers: list[str] | None = None):
    identifier_xml = "\n".join(f"<dc:identifier>{identifier}</dc:identifier>" for identifier in identifiers or [])
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>""",
        )
        archive.writestr(
            "OEBPS/content.opf",
            f"""<?xml version="1.0"?><package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            {identifier_xml}<dc:title>{title}</dc:title><dc:creator>{author}</dc:creator>
            </metadata><manifest>
            <item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/>
            </manifest><spine><itemref idref="c1"/></spine></package>""",
        )
        archive.writestr("OEBPS/one.xhtml", "<html><body><h1>正文</h1></body></html>")


def write_epub_nav_fixture(path: Path):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>""",
        )
        archive.writestr(
            "OEBPS/content.opf",
            """<?xml version="1.0"?><package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>目录选择测试</dc:title><dc:creator>测试作者</dc:creator><dc:identifier>urn:isbn:9787111111115</dc:identifier>
            <dc:language>zh-CN</dc:language><dc:publisher>测试出版社</dc:publisher><dc:subject>悬疑</dc:subject><dc:subject>推理</dc:subject>
            <meta name="cover" content="cover"/>
            </metadata><manifest>
            <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
            <item id="cover" href="cover.jpg" media-type="image/jpeg"/>
            <item id="c1" href="chapters/one.xhtml" media-type="application/xhtml+xml"/>
            <item id="c2" href="chapters/two.xhtml" media-type="application/xhtml+xml"/>
            </manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>""",
        )
        archive.writestr(
            "OEBPS/nav.xhtml",
            """<html><body>
            <nav epub:type="landmarks"><ol><li><a href="cover.xhtml">封面</a></li></ol></nav>
            <nav epub:type="toc"><ol><li><a href="chapters/one.xhtml">第一节</a></li><li><a href="chapters/two.xhtml#p2">第二节</a></li></ol></nav>
            </body></html>""",
        )
        archive.writestr("OEBPS/chapters/one.xhtml", "<html><body><h1>fallback one</h1></body></html>")
        archive.writestr("OEBPS/chapters/two.xhtml", "<html><body><h1>fallback two</h1></body></html>")
        archive.writestr("OEBPS/cover.jpg", b"fake-jpeg")


def write_epub_ncx_fixture(path: Path):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>""",
        )
        archive.writestr(
            "OEBPS/content.opf",
            """<?xml version="1.0"?><package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>NCX 目录测试</dc:title><dc:creator>测试作者</dc:creator>
            </metadata><manifest>
            <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
            <item id="c1" href="Text/chapter01.xhtml" media-type="application/xhtml+xml"/>
            <item id="c2" href="Text/chapter02.xhtml" media-type="application/xhtml+xml"/>
            </manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>""",
        )
        archive.writestr(
            "OEBPS/toc.ncx",
            """<?xml version="1.0" encoding="UTF-8"?><ncx><navMap>
            <navPoint><navLabel><text>序幕 苏格兰</text></navLabel><content src="Text/chapter01.xhtml#start"/></navPoint>
            <navPoint><navLabel><text>食人树</text></navLabel><content src="Text/chapter02.xhtml"/></navPoint>
            </navMap></ncx>""",
        )
        archive.writestr("OEBPS/Text/chapter01.xhtml", "<html><body><h1>不应优先使用</h1></body></html>")
        archive.writestr("OEBPS/Text/chapter02.xhtml", "<html><body><h1>不应优先使用</h1></body></html>")


def write_epub_without_toc_fixture(path: Path, one_body: str, two_body: str):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>""",
        )
        archive.writestr(
            "OEBPS/content.opf",
            """<?xml version="1.0"?><package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>无目录测试</dc:title><dc:creator>测试作者</dc:creator>
            </metadata><manifest>
            <item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/>
            <item id="c2" href="two.xhtml" media-type="application/xhtml+xml"/>
            </manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>""",
        )
        archive.writestr("OEBPS/one.xhtml", f"<html><body>{one_body}</body></html>")
        archive.writestr("OEBPS/two.xhtml", f"<html><body>{two_body}</body></html>")


def write_comic_fixture(path: Path, volume: int = 1, cover_bytes: bytes = b"one"):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "ComicInfo.xml",
            f"""<ComicInfo><Title>第{volume}卷</Title><Series>星舰漫画</Series><Volume>{volume}</Volume><Writer>画师</Writer><Publisher>星舰出版社</Publisher><Summary>漫画简介</Summary><Tags>manga,space</Tags><Pages><Page Image="0" Type="FrontCover"/></Pages></ComicInfo>""",
        )
        archive.writestr("001.jpg", cover_bytes)
        archive.writestr("002.jpg", b"two")


def write_pdf_fixture(path: Path):
    path.write_bytes(
        b"%PDF-1.4\n"
        b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
        b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
        b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n"
        b"trailer << /Root 1 0 R >>\n%%EOF\n"
    )


def write_pdf_metadata_fixture(path: Path):
    info = "/Title (星舰手册) /Author (作者甲) /Subject (PDF 简介) /Keywords (space,manual,science)"
    path.write_bytes(
        (
            "%PDF-1.4\n"
            "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
            "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
            "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n"
            f"4 0 obj << {info} >> endobj\n"
            "trailer << /Root 1 0 R /Info 4 0 R >>\n%%EOF\n"
        ).encode("utf-8")
    )


def test_path_security_rejects_sensitive_paths(test_settings):
    test_settings.resolved_monitor_root.mkdir(parents=True)
    service = PathSecurityService(test_settings)

    try:
        service.validate_monitor_folder("/etc")
    except PathSecurityError as error:
        assert error.code == "SENSITIVE_PATH"
    else:
        raise AssertionError("expected sensitive path rejection")


def test_path_security_accepts_monitor_root_child(test_settings):
    monitor_root = test_settings.resolved_monitor_root
    library = monitor_root / "library"
    library.mkdir(parents=True)
    service = PathSecurityService(test_settings)

    validation = service.validate_monitor_folder(str(library))

    assert validation.real_path == library.resolve()
    assert validation.real_monitor_root == monitor_root.resolve()


def test_normalize_configured_path_uses_workspace_root():
    assert normalize_configured_path("books").endswith("/shuku-starship/books")


def test_stage_managed_import_file_copy_and_move(tmp_path):
    source = tmp_path / "source.epub"
    copied = tmp_path / "copied.epub"
    moved = tmp_path / "moved.epub"
    source.write_text("copy me", encoding="utf-8")
    stage_managed_import_file(source, copied, "COPY")
    assert source.exists()
    assert copied.read_text(encoding="utf-8") == "copy me"

    stage_managed_import_file(source, moved, "MOVE")
    assert not source.exists()
    assert moved.read_text(encoding="utf-8") == "copy me"


def test_stage_managed_import_file_move_reports_read_only_source(tmp_path, monkeypatch):
    source = tmp_path / "source.epub"
    managed = tmp_path / "managed.epub"
    source.write_text("copy me", encoding="utf-8")
    original_unlink = Path.unlink

    def fail_rename(self, target):
        raise OSError("cross-device move")

    def maybe_fail_unlink(self, *args, **kwargs):
        if self == source:
            raise OSError("Read-only file system")
        return original_unlink(self, *args, **kwargs)

    monkeypatch.setattr(Path, "rename", fail_rename)
    monkeypatch.setattr(Path, "unlink", maybe_fail_unlink)

    try:
        stage_managed_import_file(source, managed, "MOVE")
    except RuntimeError as exc:
        assert "移动模式需要删除监控目录中的源文件" in str(exc)
    else:
        raise AssertionError("MOVE should fail when source cannot be deleted")
    assert source.exists()
    assert not managed.exists()


def test_work_merge_key_uses_title_author_and_media_type():
    assert _work_merge_key("epub", "斯泰尔斯庄园奇案 (午夜文库)", "阿加莎·克里斯蒂", "B00T238N28", "9787111111115") == "ebook:斯泰尔斯庄园奇案午夜文库:阿加莎·克里斯蒂"
    assert _work_merge_key("pdf", "斯泰尔斯庄园奇案 (午夜文库)", "阿加莎·克里斯蒂") == "ebook:斯泰尔斯庄园奇案午夜文库:阿加莎·克里斯蒂"
    assert _work_merge_key("cbz", "斯泰尔斯庄园奇案 (午夜文库)", "阿加莎·克里斯蒂") == "comic:斯泰尔斯庄园奇案午夜文库:阿加莎·克里斯蒂"


def test_import_epub_creates_library_records(db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    epub = tmp_path / "book.epub"
    write_epub_fixture(epub)

    result = import_managed_book(db_session, test_settings, ImportOptions(source_file_path=epub, origin="MANUAL", original_name="book.epub"))

    assert result.import_status == "completed"
    assert result.type == "ebook"
    assert _count(db_session, "LibraryWork") == 1
    assert _count(db_session, "LibraryEdition") == 1
    assert _count(db_session, "LibraryReadingUnit") == 2
    assert _count(db_session, "ImportTask") == 1
    assert _count(db_session, "OrganizeJob") == 1


def test_watch_epub_prefers_filename_when_opf_title_conflicts(db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    source_name = "斯泰尔斯庄园奇案_阿加莎·克里 - (英)阿加莎·克里斯蒂.epub"
    epub = tmp_path / source_name
    write_epub_metadata_fixture(epub, "岛田庄司精选作品合集共14册（日本推理小说之神，新本格派导师岛田庄司）", "岛田庄司")

    result = import_managed_book(
        db_session,
        test_settings,
        ImportOptions(source_file_path=epub, origin="WATCH", original_name=source_name, monitor_folder_id="folder-1"),
    )

    assert result.duplicate is False
    work = db_session.execute(text("SELECT title, author FROM LibraryWork")).mappings().first()
    assert work["title"] == "斯泰尔斯庄园奇案"
    assert work["author"] == "阿加莎·克里斯蒂"
    raw = json.loads(db_session.execute(text("SELECT rawJson FROM LibraryMetadata")).scalar())
    assert raw["originalDcTitle"].startswith("岛田庄司精选作品合集共14册")
    assert raw["titleOverrideReason"] == "watch-source-filename-conflicts-with-opf"


def test_parse_series_volume_info_from_real_watch_layout():
    path = Path("/monitor/[辣妹因为惩罚游戏才向我这个边缘人告白，但显然是真心爱上我了][結石][Vol.01-Vol.10]/辣妹因为惩罚游戏才向我这个边缘人告白，但显然是真心爱上我了 10.epub")

    parsed = parse_series_volume_info(path, path.name, "WATCH")

    assert parsed is not None
    assert parsed.series_name == "辣妹因为惩罚游戏才向我这个边缘人告白，但显然是真心爱上我了"
    assert parsed.author == "結石"
    assert parsed.series_index == 10
    assert parsed.title == "第 10 卷"


def test_watch_epub_import_merges_series_volumes_from_folder_layout(db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    series_dir = tmp_path / "[辣妹因为惩罚游戏才向我这个边缘人告白，但显然是真心爱上我了][結石][Vol.01-Vol.10]"
    series_dir.mkdir()
    first = series_dir / "辣妹因为惩罚游戏才向我这个边缘人告白，但显然是真心爱上我了 01.epub"
    tenth = series_dir / "辣妹因为惩罚游戏才向我这个边缘人告白，但显然是真心爱上我了 10.epub"
    duplicate_tenth = series_dir / "辣妹因为惩罚游戏才向我这个边缘人告白，但显然是真心爱上我了 10 copy.epub"
    write_epub_metadata_fixture(first, "第 1 卷", "封面作者")
    write_epub_metadata_fixture(tenth, "第 10 卷", "封面作者")
    write_epub_metadata_fixture(duplicate_tenth, "第 10 卷", "封面作者")

    first_result = import_managed_book(db_session, test_settings, ImportOptions(source_file_path=first, origin="WATCH", original_name=first.name, monitor_folder_id="folder-1"))
    tenth_result = import_managed_book(db_session, test_settings, ImportOptions(source_file_path=tenth, origin="WATCH", original_name=tenth.name, monitor_folder_id="folder-1"))
    duplicate_result = import_managed_book(db_session, test_settings, ImportOptions(source_file_path=duplicate_tenth, origin="WATCH", original_name=tenth.name, monitor_folder_id="folder-1"))

    assert first_result.work_id == tenth_result.work_id == duplicate_result.work_id
    assert first_result.edition_id == tenth_result.edition_id == duplicate_result.edition_id
    assert duplicate_result.duplicate is True
    assert _count(db_session, "LibraryWork") == 1
    assert _count(db_session, "LibraryEdition") == 1
    assert _count(db_session, "LibraryVolume") == 2
    work = db_session.execute(text("SELECT title, author FROM LibraryWork")).mappings().first()
    assert work["title"] == "辣妹因为惩罚游戏才向我这个边缘人告白，但显然是真心爱上我了"
    assert work["author"] == "結石"
    edition = db_session.execute(text("SELECT chapterCount, sizeBytes FROM LibraryEdition")).mappings().first()
    assert edition["chapterCount"] == 2
    assert edition["sizeBytes"] > 0
    volumes = db_session.execute(text("SELECT title, volumeIndex, sortOrder, chapterCount FROM LibraryVolume ORDER BY sortOrder")).mappings().all()
    assert [dict(volume) for volume in volumes] == [
        {"title": "第 1 卷", "volumeIndex": 1, "sortOrder": 1000, "chapterCount": 1},
        {"title": "第 10 卷", "volumeIndex": 10, "sortOrder": 10000, "chapterCount": 1},
    ]


def test_import_epub_merges_same_title_author_despite_different_identifiers(db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    first = tmp_path / "first.epub"
    second = tmp_path / "second.epub"
    write_epub_metadata_fixture(first, "斯泰尔斯庄园奇案", "阿加莎·克里斯蒂", ["B00T238N28"])
    write_epub_metadata_fixture(second, "斯泰尔斯庄园奇案", "阿加莎·克里斯蒂", ["B00DIFFERENT"])

    first_result = import_managed_book(db_session, test_settings, ImportOptions(source_file_path=first, origin="MANUAL", original_name=first.name))
    second_result = import_managed_book(db_session, test_settings, ImportOptions(source_file_path=second, origin="MANUAL", original_name=second.name))

    assert first_result.duplicate is False
    assert second_result.duplicate is True
    assert first_result.work_id == second_result.work_id
    assert _count(db_session, "LibraryWork") == 1
    assert db_session.execute(text("SELECT mergeKey FROM LibraryWork")).scalar() == "ebook:斯泰尔斯庄园奇案:阿加莎·克里斯蒂"


def test_import_epub_falls_back_to_bangumi_and_skips_pending_organize_queue(db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    create_metadata_provider_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    gateway = serve_import_metadata_gateways()
    try:
        for key, value in {
            "metadata.douban.mode": "api",
            "metadata.douban.baseUrl": f"http://127.0.0.1:{gateway.server_port}",
            "metadata.bangumi.baseUrl": f"http://127.0.0.1:{gateway.server_port}",
            "metadata.bangumi.userAgent": "ShukuImportTest/1.0",
        }.items():
            set_system_setting(db_session, key, value)
        epub = tmp_path / "fallback.epub"
        write_epub_fixture(epub)

        result = import_managed_book(db_session, test_settings, ImportOptions(source_file_path=epub, origin="MANUAL", original_name="fallback.epub"))

        assert result.import_status == "completed"
        assert [request["path"] for request in gateway.requests] == ["/v2/book/search?q=%E7%9B%AE%E5%BD%95%E6%B5%8B%E8%AF%95&count=3", "/v0/search/subjects"]
        work = db_session.execute(text("SELECT title, author, description, tags, organized, organizeStatus FROM LibraryWork")).mappings().first()
        assert work["title"] == "目录测试"
        assert work["author"] == "Bangumi 作者"
        assert work["description"] == "Bangumi fallback description"
        assert json.loads(work["tags"]) == ["小说", "科幻"]
        assert work["organized"] == 1
        assert work["organizeStatus"] == "APPLIED"
        assert db_session.execute(text("SELECT COUNT(*) FROM OrganizeJob WHERE status IN ('PENDING', 'REVIEWING', 'FAILED')")).scalar() == 0
        assert db_session.execute(text("SELECT status FROM OrganizeJob")).scalar() == "APPLIED"
        assert db_session.execute(text("SELECT DISTINCT source FROM MetadataSuggestion")).scalar() == "bangumi"
    finally:
        gateway.shutdown()


def test_parse_epub_nav_uses_toc_block_and_preserves_raw_opf_metadata(tmp_path):
    epub = tmp_path / "nav.epub"
    write_epub_nav_fixture(epub)

    metadata = parse_epub_metadata(epub)

    assert metadata["chapters"] == [
        {"title": "第一节", "href": "chapters/one.xhtml", "idref": "c1", "mediaType": "application/xhtml+xml", "sortOrder": 1},
        {"title": "第二节", "href": "chapters/two.xhtml#p2", "idref": "c2", "mediaType": "application/xhtml+xml", "sortOrder": 2},
    ]
    assert metadata["isbn"] == "9787111111115"
    assert metadata["publisher"] == "测试出版社"
    assert metadata["subjects"] == ["悬疑", "推理"]
    assert metadata["coverPath"] == "cover.jpg"
    assert metadata["rawMetadata"]["dc:subject"] == ["悬疑", "推理"]
    assert metadata["rawMetadata"]["meta"] == [{"name": "cover", "content": "cover"}]


def test_parse_epub_metadata_does_not_extract_isbn_from_uuid(tmp_path):
    epub = tmp_path / "uuid.epub"
    with zipfile.ZipFile(epub, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>""",
        )
        archive.writestr(
            "OEBPS/content.opf",
            """<?xml version="1.0"?><package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:identifier>urn:uuid:273fd756-62f2-4858-8d67-99e08f24bba9</dc:identifier>
            <dc:identifier>B00T238N28</dc:identifier>
            <dc:title>斯泰尔斯庄园奇案 (午夜文库)</dc:title><dc:creator>阿加莎·克里斯蒂</dc:creator>
            </metadata><manifest>
            <item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/>
            </manifest><spine><itemref idref="c1"/></spine></package>""",
        )
        archive.writestr("OEBPS/one.xhtml", "<html><body><h1>正文</h1></body></html>")

    metadata = parse_epub_metadata(epub)

    assert metadata["isbn"] is None
    assert metadata["identifier"] == "B00T238N28"


def test_parse_epub_ncx_titles_take_priority_over_headings(tmp_path):
    epub = tmp_path / "ncx.epub"
    write_epub_ncx_fixture(epub)

    metadata = parse_epub_metadata(epub)

    assert metadata["chapters"] == [
        {"title": "序幕 苏格兰", "href": "Text/chapter01.xhtml#start", "idref": "c1", "mediaType": "application/xhtml+xml", "sortOrder": 1},
        {"title": "食人树", "href": "Text/chapter02.xhtml", "idref": "c2", "mediaType": "application/xhtml+xml", "sortOrder": 2},
    ]


def test_parse_epub_without_toc_uses_headings_then_numbered_titles(tmp_path):
    headed = tmp_path / "headed.epub"
    write_epub_without_toc_fixture(headed, "<h1>第一节</h1>", "<h2>第二节</h2>")
    headed_metadata = parse_epub_metadata(headed)
    assert [chapter["title"] for chapter in headed_metadata["chapters"]] == ["第一节", "第二节"]

    untitled = tmp_path / "untitled.epub"
    write_epub_without_toc_fixture(untitled, "<p>content</p>", "<p>content</p>")
    untitled_metadata = parse_epub_metadata(untitled)
    assert [chapter["title"] for chapter in untitled_metadata["chapters"]] == ["第 1 章", "第 2 章"]


def test_import_comic_defers_page_units_and_detects_duplicate(db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    comic = tmp_path / "星舰漫画 Vol.1.zip"
    write_comic_fixture(comic)

    first = import_managed_book(db_session, test_settings, ImportOptions(source_file_path=comic, origin="MANUAL", original_name=comic.name))
    second = import_managed_book(db_session, test_settings, ImportOptions(source_file_path=comic, origin="MANUAL", original_name=comic.name))

    assert first.type == "comic"
    assert first.total_units == 2
    assert second.duplicate is True
    assert _count(db_session, "LibraryWork") == 1
    assert _count(db_session, "LibraryVolume") == 1
    assert _count(db_session, "LibraryReadingUnit") == 0
    assert db_session.execute(text("SELECT contentHash FROM ImportTask WHERE duplicate = 0")).scalar() is None
    file_row = db_session.execute(text("SELECT fullHash, hashStatus FROM LibraryFile")).mappings().first()
    assert file_row["fullHash"] is None
    assert file_row["hashStatus"] == "PARTIAL_PENDING"
    work = db_session.execute(text("SELECT title, author, description, tags FROM LibraryWork")).mappings().first()
    assert work["title"] == "星舰漫画"
    assert work["author"] == "画师"
    assert work["description"] == "漫画简介"
    assert json.loads(work["tags"]) == ["manga", "space"]
    edition = db_session.execute(text("SELECT publisher, pageCount, coverPath, coverStatus FROM LibraryEdition")).mappings().first()
    assert edition["publisher"] == "星舰出版社"
    assert edition["pageCount"] == 2
    assert edition["coverPath"]
    assert Path(edition["coverPath"]).read_bytes() == b"one"
    assert edition["coverStatus"] == "READY"
    volume = db_session.execute(text("SELECT title, volumeIndex FROM LibraryVolume")).mappings().first()
    assert volume["title"] == "第 1 卷"
    assert volume["volumeIndex"] == 1
    raw_metadata = json.loads(db_session.execute(text("SELECT rawJson FROM LibraryMetadata WHERE source = 'comic_info'")).scalar())
    assert raw_metadata["comicInfo"]["Publisher"] == "星舰出版社"
    assert raw_metadata["comicInfo"]["Tags"] == "manga,space"


def test_import_comic_updates_generated_work_cover_to_first_volume(db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    volume_2 = tmp_path / "星舰漫画 Vol.2.zip"
    volume_1 = tmp_path / "星舰漫画 Vol.1.zip"
    write_comic_fixture(volume_2, volume=2, cover_bytes=b"volume-two-cover")
    write_comic_fixture(volume_1, volume=1, cover_bytes=b"volume-one-cover")

    first_import = import_managed_book(db_session, test_settings, ImportOptions(source_file_path=volume_2, origin="MANUAL", original_name=volume_2.name))
    second_import = import_managed_book(db_session, test_settings, ImportOptions(source_file_path=volume_1, origin="MANUAL", original_name=volume_1.name))

    assert first_import.work_id == second_import.work_id
    work_cover = db_session.execute(text("SELECT coverPath FROM LibraryWork WHERE id = :work_id"), {"work_id": first_import.work_id}).scalar()
    assert work_cover is not None
    assert Path(work_cover).read_bytes() == b"volume-one-cover"
    assert db_session.execute(text("SELECT volumeIndex FROM LibraryVolume WHERE coverPath = :cover_path"), {"cover_path": work_cover}).scalar() == 1


def test_import_pdf_creates_library_records(db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    pdf = tmp_path / "manual.pdf"
    write_pdf_fixture(pdf)

    result = import_managed_book(db_session, test_settings, ImportOptions(source_file_path=pdf, origin="MANUAL", original_name="Manual PDF.pdf"))

    assert result.import_status == "completed"
    assert result.type == "ebook"
    assert result.format == "pdf"
    assert result.total_units == 1
    assert _count(db_session, "LibraryWork") == 1
    edition = db_session.execute(text("SELECT format, coverPath, coverStatus FROM LibraryEdition")).mappings().first()
    assert edition["format"] == "PDF"
    assert edition["coverStatus"] == "READY"
    assert edition["coverPath"]
    assert Path(edition["coverPath"]).read_bytes().startswith(b"\xff\xd8")
    assert db_session.execute(text("SELECT coverPath FROM LibraryWork")).scalar() == edition["coverPath"]
    assert db_session.execute(text("SELECT coverPath FROM LibraryVolume")).scalar() == edition["coverPath"]
    assert db_session.execute(text("SELECT mimeType FROM LibraryFile")).scalar() == "application/pdf"
    raw_metadata = json.loads(db_session.execute(text("SELECT rawJson FROM LibraryMetadata WHERE source = 'pdf'")).scalar())
    assert raw_metadata["coverRenderedFromPage"] == 1
    assert _count(db_session, "LibraryReadingUnit") == 1


def test_import_pdf_maps_subject_keywords_metadata(db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    pdf = tmp_path / "metadata.pdf"
    write_pdf_metadata_fixture(pdf)

    parsed = parse_pdf_metadata(pdf, "fallback.pdf")
    assert parsed["title"] == "星舰手册"
    assert parsed["author"] == "作者甲"
    assert parsed["description"] == "PDF 简介"
    assert parsed["tags"] == ["space", "manual", "science"]

    result = import_managed_book(db_session, test_settings, ImportOptions(source_file_path=pdf, origin="MANUAL", original_name="fallback.pdf"))

    assert result.import_status == "completed"
    work = db_session.execute(text("SELECT title, author, description, tags FROM LibraryWork")).mappings().first()
    assert work["title"] == "星舰手册"
    assert work["author"] == "作者甲"
    assert work["description"] == "PDF 简介"
    assert json.loads(work["tags"]) == ["space", "manual", "science"]
    edition = db_session.execute(text("SELECT description FROM LibraryEdition")).mappings().first()
    assert edition["description"] == "PDF 简介"
    raw_metadata = json.loads(db_session.execute(text("SELECT rawJson FROM LibraryMetadata WHERE source = 'pdf'")).scalar())
    assert raw_metadata["Subject"] == "PDF 简介"
    assert raw_metadata["Keywords"] == "space,manual,science"


def test_monitor_ignore_rules():
    folder = MonitorFolderConfig(id="1", root_path="/tmp", ignore_patterns="*.tmp\nskip", min_file_size_bytes=1)
    assert should_ignore_file(Path("/tmp/.hidden/book.epub"), folder)
    assert should_ignore_file(Path("/tmp/book.tmp"), folder)
    assert should_ignore_file(Path("/tmp/readme.txt"), folder)
    assert not should_ignore_file(Path("/tmp/book.epub"), folder)


def test_parse_comic_volume_from_name_uses_parent_folder():
    parsed = parse_comic_volume_from_name(Path("/monitor/[齐木楠雄的灾难][麻生周一]/Vol.05.cbz"), "Vol.05.cbz")
    assert parsed == {"seriesName": "齐木楠雄的灾难", "seriesIndex": 5.0, "title": "齐木楠雄的灾难 (5)", "author": "麻生周一"}
