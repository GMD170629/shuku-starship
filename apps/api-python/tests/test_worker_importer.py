import json
import zipfile
from pathlib import Path

from sqlalchemy import text

from app.worker.importer import ImportOptions, import_managed_book, parse_comic_volume_from_name, parse_epub_metadata, parse_pdf_metadata, stage_managed_import_file
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
            <dc:title>目录选择测试</dc:title><dc:creator>测试作者</dc:creator><dc:identifier>urn:isbn:9787111111111</dc:identifier>
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


def write_comic_fixture(path: Path):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "ComicInfo.xml",
            """<ComicInfo><Title>第一卷</Title><Series>星舰漫画</Series><Volume>1</Volume><Writer>画师</Writer><Publisher>星舰出版社</Publisher><Summary>漫画简介</Summary><Tags>manga,space</Tags><Pages><Page Image="0" Type="FrontCover"/></Pages></ComicInfo>""",
        )
        archive.writestr("001.jpg", b"one")
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


def test_parse_epub_nav_uses_toc_block_and_preserves_raw_opf_metadata(tmp_path):
    epub = tmp_path / "nav.epub"
    write_epub_nav_fixture(epub)

    metadata = parse_epub_metadata(epub)

    assert metadata["chapters"] == [
        {"title": "第一节", "href": "chapters/one.xhtml", "idref": "c1", "mediaType": "application/xhtml+xml", "sortOrder": 1},
        {"title": "第二节", "href": "chapters/two.xhtml#p2", "idref": "c2", "mediaType": "application/xhtml+xml", "sortOrder": 2},
    ]
    assert metadata["isbn"] == "9787111111111"
    assert metadata["publisher"] == "测试出版社"
    assert metadata["subjects"] == ["悬疑", "推理"]
    assert metadata["coverPath"] == "cover.jpg"
    assert metadata["rawMetadata"]["dc:subject"] == ["悬疑", "推理"]
    assert metadata["rawMetadata"]["meta"] == [{"name": "cover", "content": "cover"}]


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


def test_import_comic_creates_page_units_and_detects_duplicate(db_session, test_settings, tmp_path):
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
    assert _count(db_session, "LibraryReadingUnit") == 2
    work = db_session.execute(text("SELECT title, author, description, tags FROM LibraryWork")).mappings().first()
    assert work["title"] == "星舰漫画"
    assert work["author"] == "画师"
    assert work["description"] == "漫画简介"
    assert json.loads(work["tags"]) == ["manga", "space"]
    edition = db_session.execute(text("SELECT publisher, pageCount, coverStatus FROM LibraryEdition")).mappings().first()
    assert edition["publisher"] == "星舰出版社"
    assert edition["pageCount"] == 2
    assert edition["coverStatus"] == "READY"
    volume = db_session.execute(text("SELECT title, volumeIndex FROM LibraryVolume")).mappings().first()
    assert volume["title"] == "第 1 卷"
    assert volume["volumeIndex"] == 1
    raw_metadata = json.loads(db_session.execute(text("SELECT rawJson FROM LibraryMetadata WHERE source = 'comic_info'")).scalar())
    assert raw_metadata["comicInfo"]["Publisher"] == "星舰出版社"
    assert raw_metadata["comicInfo"]["Tags"] == "manga,space"


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
