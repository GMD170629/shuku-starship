from functools import partial
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Thread
from urllib.parse import parse_qs, quote, urlparse
import zipfile

from sqlalchemy import text

from app.api.routes import compat
from app.core.auth import hash_password
from app.models.auth import User
from app.services.organize_service import bangumi_candidates, douban_candidates, system_settings
from app.services.download_queue import process_next_download_task
from app.worker.importer import _auto_apply_epub_metadata
from tests.test_worker_importer import create_worker_tables, write_comic_fixture, write_epub_fixture, write_pdf_fixture


def _login(client, db_session):
    user = User(email="admin@example.com", name="管理员", password_hash=hash_password("starshipnas"), role="admin")
    db_session.add(user)
    db_session.commit()
    response = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "starshipnas"})
    assert response.status_code == 200


def create_source_tables(db_session):
    db_session.execute(
        text(
            """CREATE TABLE Source (
                id TEXT PRIMARY KEY, name TEXT, kind TEXT, providerType TEXT, enabled BOOLEAN, priority INTEGER,
                config TEXT, credentialsKey TEXT, capabilities TEXT, rateLimit TEXT, lastTestAt TEXT,
                lastTestStatus TEXT, lastError TEXT, createdAt TEXT, updatedAt TEXT
            )"""
        )
    )
    db_session.execute(
        text(
            """CREATE TABLE SourceSearchRecord (
                id TEXT PRIMARY KEY, sourceId TEXT, providerType TEXT, externalId TEXT, title TEXT,
                subtitle TEXT, author TEXT, description TEXT, coverUrl TEXT, externalUrl TEXT, format TEXT,
                size TEXT, language TEXT, publishedAt TEXT, downloadAvailable BOOLEAN, downloadMeta TEXT,
                raw TEXT, status TEXT, createdAt TEXT, updatedAt TEXT, UNIQUE(sourceId, externalId)
            )"""
        )
    )
    db_session.commit()


def create_download_tables(db_session):
    db_session.execute(
        text(
            """CREATE TABLE DownloadTask (
                id TEXT PRIMARY KEY, sourceId TEXT, searchRecordId TEXT, bookId TEXT, type TEXT, status TEXT,
                displayName TEXT, remoteRef TEXT, savePath TEXT, filePath TEXT, errorMessage TEXT,
                progress INTEGER, createdAt TEXT, updatedAt TEXT
            )"""
        )
    )
    db_session.commit()


def create_organize_detail_tables(db_session):
    db_session.execute(
        text(
            """CREATE TABLE MetadataSuggestion (
                id TEXT PRIMARY KEY, jobId TEXT, field TEXT, currentValue TEXT, suggestedValue TEXT,
                source TEXT, confidence REAL, reason TEXT, status TEXT, createdAt TEXT, updatedAt TEXT
            )"""
        )
    )
    db_session.execute(
        text(
            """CREATE TABLE DuplicateCandidate (
                id TEXT PRIMARY KEY, jobId TEXT, targetWorkId TEXT, reasons TEXT, confidence REAL,
                suggestedAction TEXT, status TEXT, createdAt TEXT, updatedAt TEXT
            )"""
        )
    )
    db_session.commit()


def serve_directory(directory):
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(directory)))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def serve_qbittorrent_api():
    requests = []

    class QbitHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def do_POST(self):
            length = int(self.headers.get("content-length") or "0")
            body = self.rfile.read(length).decode("utf-8")
            form = {key: values[0] for key, values in parse_qs(body).items()}
            requests.append({"path": self.path, "form": form, "cookie": self.headers.get("cookie")})
            if self.path == "/api/v2/auth/login":
                self.send_response(200)
                self.send_header("Set-Cookie", "SID=test-session")
                self.end_headers()
                self.wfile.write(b"Ok.")
                return
            if self.path == "/api/v2/torrents/add":
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"Ok.")
                return
            self.send_response(404)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), QbitHandler)
    server.requests = requests
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def serve_zlibrary_eapi(mode="ok"):
    requests = []

    class ZlibHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def json_response(self, status, payload):
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=UTF-8")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_POST(self):
            length = int(self.headers.get("content-length") or "0")
            body = self.rfile.read(length).decode("utf-8")
            form = {key: values[0] for key, values in parse_qs(body).items()}
            requests.append({"method": "POST", "path": self.path, "form": form, "cookie": self.headers.get("cookie")})
            if mode == "browser_check":
                encoded = b"<html><title>Checking your browser ...</title></html>"
                self.send_response(503)
                self.send_header("content-type", "text/html;charset=utf-8")
                self.send_header("content-length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
                return
            if self.path == "/eapi/user/login":
                if mode == "bad_login":
                    self.json_response(400, {"success": 0, "error": "Incorrect email or password"})
                    return
                self.json_response(200, {"success": 1, "user": {"id": "user-1", "remix_userkey": "key-1"}})
                return
            if self.path == "/eapi/book/search":
                self.json_response(
                    200,
                    {
                        "success": 1,
                        "books": [
                            {
                                "id": 123,
                                "hash": "abc123",
                                "title": "Orbital Mechanics",
                                "author": "Ada Orbit",
                                "publisher": "Star Press",
                                "language": "english",
                                "extension": "EPUB",
                                "filesizeString": "2 MB",
                                "cover": f"http://127.0.0.1:{server.server_port}/covers/123.jpg",
                                "href": f"http://127.0.0.1:{server.server_port}/book/123/orbital.html",
                                "description": "Flight dynamics reference",
                                "year": 2025,
                            }
                        ],
                        "pagination": {"total_items": 1},
                    },
                )
                return
            self.send_response(404)
            self.end_headers()

        def do_GET(self):
            requests.append({"method": "GET", "path": self.path, "cookie": self.headers.get("cookie"), "referer": self.headers.get("referer")})
            if mode == "browser_check":
                encoded = b"<html><title>Checking your browser ...</title></html>"
                self.send_response(503)
                self.send_header("content-type", "text/html;charset=utf-8")
                self.send_header("content-length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
                return
            if self.path == "/eapi/book/123/abc123":
                self.json_response(200, {"success": 1, "book": {"id": 123, "hash": "abc123", "title": "Orbital Mechanics"}})
                return
            if self.path == "/eapi/book/123/abc123/file":
                if "remix_userid=user-1" not in (self.headers.get("cookie") or ""):
                    self.json_response(400, {"success": 0, "error": "Please login"})
                    return
                self.json_response(200, {"success": 1, "file": {"downloadLink": f"http://127.0.0.1:{server.server_port}/download/orbital.epub", "extension": "epub"}})
                return
            if self.path == "/download/orbital.epub":
                encoded = b"zlibrary-epub"
                self.send_response(200)
                self.send_header("content-type", "application/epub+zip")
                self.send_header("content-disposition", "attachment; filename=orbital.epub")
                self.send_header("content-length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
                return
            self.send_response(404)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), ZlibHandler)
    server.requests = requests
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def serve_ai_metadata_gateway():
    requests = []

    class AiHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def do_POST(self):
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            requests.append({"path": self.path, "authorization": self.headers.get("authorization"), "body": body})
            payload = {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "suggestions": [
                                        {"field": "title", "value": "AI Clean Title", "confidence": 0.91, "reason": "cleaned title"},
                                        {"field": "tags", "value": ["space", "ai"], "confidence": 0.7, "reason": "inferred tags"},
                                    ]
                                }
                            )
                        }
                    }
                ]
            }
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer(("127.0.0.1", 0), AiHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    server.requests = requests
    return server


def serve_douban_api_gateway():
    requests = []

    class DoubanHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def do_GET(self):
            requests.append({"path": self.path, "accept": self.headers.get("accept")})
            payload = {
                "id": "1234567",
                "title": "Douban Clean Title",
                "author": ["External Author"],
                "summary": "External description",
                "tags": [{"name": "fiction"}, {"name": "space"}],
                "pubdate": "2024-05",
            }
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer(("127.0.0.1", 0), DoubanHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    server.requests = requests
    return server


def serve_douban_crawler_gateway():
    requests = []

    class DoubanCrawlerHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def do_GET(self):
            requests.append({"path": self.path, "accept": self.headers.get("accept"), "user_agent": self.headers.get("user-agent")})
            if self.path.startswith("/subject_search"):
                cover_url = f"http://127.0.0.1:{self.server.server_port}/covers/cover.jpg"
                revised_cover_url = f"http://127.0.0.1:{self.server.server_port}/covers/revised.jpg"
                body = """
                <html><script>
                window.__DATA__ = {"items":[
                  {"tpl_name":"search_subject","id":4913064,"title":"活着","abstract":"余华 / 作家出版社 / 2012-8 / 28.00元","abstract_2":"","cover_url":"__COVER_URL__","url":"/subject/4913064/"},
                  {"tpl_name":"search_subject","id":4913065,"title":"活着：新版","abstract":"余华 / 北京十月文艺出版社 / 2021-1 / 45.00元","abstract_2":"新版简介","cover_url":"__REVISED_COVER_URL__","url":"/subject/4913065/"}
                ]};
                </script></html>
                """.replace("__COVER_URL__", cover_url).replace("__REVISED_COVER_URL__", revised_cover_url)
            elif self.path.startswith("/subject/4913064"):
                cover_url = f"http://127.0.0.1:{self.server.server_port}/covers/large.jpg"
                body = """
                <html>
                  <script type="application/ld+json">{
                    "@context":"http://schema.org",
                    "@type":"Book",
                    "name":"活着",
                    "author":[{"@type":"Person","name":"余华"}],
                    "url":"https://book.douban.test/subject/4913064/",
                    "isbn":"9787506365437"
                  }</script>
                  <meta property="og:image" content="__COVER_URL__" />
                  <div id="info">
                    <span class="pl">出版社:</span> 作家出版社<br/>
                    <span class="pl">出版年:</span> 2012-8<br/>
                    <span class="pl">ISBN:</span> 9787506365437<br/>
                  </div>
                  <h2><span>内容简介</span></h2>
                  <div class="intro"><p>这是一本关于生命韧性的小说。</p></div>
                </html>
                """.replace("__COVER_URL__", cover_url)
            elif self.path.startswith("/covers/"):
                body = b"\xff\xd8\xff\xd9"
                self.send_response(200)
                self.send_header("content-type", "image/jpeg")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            else:
                self.send_response(404)
                self.end_headers()
                return
            encoded = body.encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer(("127.0.0.1", 0), DoubanCrawlerHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    server.requests = requests
    return server


def serve_bangumi_api_gateway():
    requests = []

    class BangumiHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def do_POST(self):
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            requests.append(
                {
                    "path": self.path,
                    "authorization": self.headers.get("authorization"),
                    "user_agent": self.headers.get("user-agent"),
                    "body": body,
                }
            )
            payload = {
                "data": [
                    {
                        "id": 42,
                        "name": "Star Comic",
                        "name_cn": "星舰漫画",
                        "summary": "Bangumi description",
                        "date": "2022-07-01",
                        "tags": [{"name": "科幻"}, {"name": "漫画"}],
                        "infobox": [
                            {"key": "作者", "value": "漫画作者"},
                            {"key": "出版社", "value": "出版社"},
                            {"key": "册数", "value": "3"},
                        ],
                    }
                ]
            }
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer(("127.0.0.1", 0), BangumiHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    server.requests = requests
    return server


def serve_priority_metadata_gateway(scenario: str):
    requests = []

    class PriorityMetadataHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def write_body(self, body: str | bytes, content_type: str = "text/html; charset=utf-8"):
            encoded = body if isinstance(body, bytes) else body.encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def json_response(self, payload: dict):
            self.write_body(json.dumps(payload, ensure_ascii=False), "application/json")

        def do_GET(self):
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query)
            requests.append({"method": "GET", "path": parsed.path, "query": query})
            if parsed.path == "/subject_search":
                search_text = (query.get("search_text") or [""])[0]
                items = []
                if scenario in {"douban-later-exact", "ai-title"}:
                    items = [
                        {"tpl_name": "search_subject", "id": 1001, "title": "黑暗坡食人树：全新修订版", "abstract": "[日]岛田庄司 / 新星出版社 / 2024-11 / 69.00元", "abstract_2": "新版", "cover_url": "https://img.example/revised.jpg", "url": "/subject/1001/"},
                        {"tpl_name": "search_subject", "id": 1002, "title": "黑暗坡食人树", "abstract": "[日]岛田庄司 / 新星出版社 / 2009-7 / 32.00元", "abstract_2": "", "cover_url": "https://img.example/exact.jpg", "url": "/subject/1002/"},
                    ]
                elif scenario in {"douban-no-exact", "no-exact"}:
                    items = [
                        {"tpl_name": "search_subject", "id": 1001, "title": "黑暗坡食人树：全新修订版", "abstract": "[日]岛田庄司 / 新星出版社 / 2024-11 / 69.00元", "abstract_2": "新版", "cover_url": "https://img.example/revised.jpg", "url": "/subject/1001/"}
                    ]
                body = f"<html><script>window.__DATA__ = {json.dumps({'items': items}, ensure_ascii=False)};</script><p>{search_text}</p></html>"
                self.write_body(body)
                return
            if parsed.path == "/subject/1002/":
                body = """
                <html>
                  <script type="application/ld+json">{
                    "@context":"http://schema.org",
                    "@type":"Book",
                    "name":"黑暗坡食人树",
                    "author":[{"@type":"Person","name":"[日]岛田庄司"}],
                    "url":"https://book.douban.test/subject/1002/",
                    "isbn":"9787802256866"
                  }</script>
                  <meta property="og:image" content="https://img.example/exact-large.jpg" />
                  <div id="info">
                    <span class="pl">出版社:</span> 新星出版社<br/>
                    <span class="pl">出版年:</span> 2009-7<br/>
                    <span class="pl">丛书:</span> 午夜文库·大师系列：岛田庄司作品·御手洗洁系列<br/>
                    <span class="pl">ISBN:</span> 9787802256866<br/>
                  </div>
                  <h2><span>内容简介</span></h2>
                  <div class="intro"><p>大楠树顶部开着锯齿状的缺口。</p></div>
                </html>
                """
                self.write_body(body)
                return
            if parsed.path == "/subject/1001/":
                body = """
                <html>
                  <script type="application/ld+json">{"@type":"Book","name":"黑暗坡食人树：全新修订版","author":[{"name":"[日]岛田庄司"}],"url":"https://book.douban.test/subject/1001/"}</script>
                  <div id="info"><span class="pl">出版社:</span> 新星出版社<br/><span class="pl">出版年:</span> 2024-11<br/></div>
                </html>
                """
                self.write_body(body)
                return
            self.send_response(404)
            self.end_headers()

        def do_POST(self):
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            requests.append({"method": "POST", "path": self.path, "body": body})
            if self.path == "/v0/search/subjects":
                if scenario == "douban-no-exact":
                    self.json_response(
                        {
                            "data": [
                                {
                                    "id": 42,
                                    "name": "Kura Yami Slope",
                                    "name_cn": "黑暗坡食人树",
                                    "summary": "Bangumi exact description",
                                    "date": "2009-07-01",
                                    "infobox": [{"key": "作者", "value": "岛田庄司"}, {"key": "出版社", "value": "新星出版社"}],
                                }
                            ]
                        }
                    )
                    return
                self.json_response({"data": [{"id": 43, "name": "Kura Yami Slope Revised", "name_cn": "黑暗坡食人树：全新修订版", "summary": "Bangumi non exact"}]})
                return
            if self.path == "/chat/completions":
                self.json_response({"choices": [{"message": {"content": json.dumps({"suggestions": [{"field": "title", "value": "黑暗坡食人树", "confidence": 0.92, "reason": "cleaned hash"}]}, ensure_ascii=False)}}]})
                return
            self.send_response(404)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), PriorityMetadataHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    server.requests = requests
    return server


def insert_priority_metadata_fixture(db_session, gateway, title: str = "黑暗坡食人树"):
    db_session.execute(text("CREATE TABLE IF NOT EXISTS SystemSetting (`key` TEXT PRIMARY KEY, `value` TEXT, `createdAt` TEXT, `updatedAt` TEXT)"))
    work_columns = {row[1] for row in db_session.execute(text("PRAGMA table_info(LibraryWork)")).all()}
    if "seriesName" not in work_columns:
        db_session.execute(text("ALTER TABLE LibraryWork ADD COLUMN seriesName TEXT"))
    for key, value in {
        "metadata.douban.mode": "crawler",
        "metadata.douban.baseUrl": f"http://127.0.0.1:{gateway.server_port}",
        "metadata.douban.userAgent": "ShukuPriorityTest/1.0",
        "metadata.bangumi.baseUrl": f"http://127.0.0.1:{gateway.server_port}",
        "metadata.bangumi.userAgent": "ShukuPriorityTest/1.0",
        "metadata.ai.baseUrl": f"http://127.0.0.1:{gateway.server_port}",
        "metadata.ai.apiKey": "ai-key",
        "metadata.ai.model": "ai-model",
    }.items():
        db_session.execute(
            text("INSERT INTO SystemSetting (`key`, `value`, `createdAt`, `updatedAt`) VALUES (:key, :value, 'now', 'now')"),
            {"key": key, "value": value},
        )
    db_session.execute(
        text(
            """INSERT INTO LibraryWork (
                id, title, normalizedTitle, author, normalizedAuthor, workType, status, publicationStatus,
                trackingStatus, tags, metadataQuality, organizeStatus, coverStatus, hidden, organized,
                mergeKey, createdAt, updatedAt
            ) VALUES (
                'work-priority', :title, :normalized, '', '', 'EPUB', 'WANT', 'UNKNOWN',
                'NOT_TRACKING', '[]', 0, 'REVIEWING', 'PENDING', 0, 0, 'epub:priority', 'now', 'now'
            )"""
        ),
        {"title": title, "normalized": title.lower()},
    )
    db_session.execute(
        text(
            """INSERT INTO LibraryEdition (
                id, workId, origin, format, importStatus, sizeBytes, "primary", hidden, createdAt, updatedAt
            ) VALUES ('edition-priority', 'work-priority', 'MANUAL', 'EPUB', 'IMPORTED', 10, 1, 0, 'now', 'now')"""
        )
    )
    db_session.execute(
        text(
            "INSERT INTO OrganizeJob (id, workId, editionId, status, issueCodes, summary, createdAt, updatedAt) VALUES ('job-priority', 'work-priority', 'edition-priority', 'REVIEWING', '[]', 'review', 'now', 'now')"
        )
    )
    db_session.commit()


def test_metadata_candidate_parsers_accept_common_provider_shapes():
    douban = douban_candidates(
        {
            "results": [
                {
                    "id": "douban-result-1",
                    "title": "搜索结果书名",
                    "authors": [{"name": "作者甲"}],
                    "summary": "简介",
                    "cover_url": "https://example.test/cover.jpg",
                    "pubdate": "2024-01",
                }
            ]
        },
        0.7,
    )
    bangumi = bangumi_candidates(
        {
            "list": [
                {
                    "id": 123,
                    "name": "Bangumi Name",
                    "name_cn": "中文条目",
                    "summary": "简介",
                    "images": {"common": "https://example.test/bgm.jpg"},
                }
            ]
        },
        0.82,
    )

    assert douban[0]["title"] == "搜索结果书名"
    assert douban[0]["author"] == "作者甲"
    assert douban[0]["coverUrl"] == "https://example.test/cover.jpg"
    assert bangumi[0]["title"] == "中文条目"
    assert bangumi[0]["coverUrl"] == "https://example.test/bgm.jpg"


def test_metadata_system_settings_decode_json_saved_values(db_session):
    db_session.execute(text("CREATE TABLE IF NOT EXISTS SystemSetting (`key` TEXT PRIMARY KEY, `value` TEXT, `createdAt` TEXT, `updatedAt` TEXT)"))
    for key, value in {
        "metadata.douban.baseUrl": '""',
        "metadata.douban.enabled": "true",
        "metadata.bangumi.userAgent": '"ShukuStarship/0.1 (https://github.com/GMD170629/shuku-starship)"',
    }.items():
        db_session.execute(
            text("INSERT INTO SystemSetting (`key`, `value`, `createdAt`, `updatedAt`) VALUES (:key, :value, 'now', 'now')"),
            {"key": key, "value": value},
        )
    db_session.commit()

    settings = system_settings(db_session, ["metadata.douban.baseUrl", "metadata.douban.enabled", "metadata.bangumi.userAgent"])

    assert settings == {
        "metadata.douban.baseUrl": "",
        "metadata.douban.enabled": "true",
        "metadata.bangumi.userAgent": "ShukuStarship/0.1 (https://github.com/GMD170629/shuku-starship)",
    }


def test_core_compat_endpoints_return_envelopes(client, db_session, test_settings):
    test_settings.resolved_monitor_root.mkdir(parents=True)
    _login(client, db_session)

    endpoints = [
        "/api/dashboard/summary",
        "/api/dashboard/recent-books",
        "/api/dashboard/continue-reading",
        "/api/dashboard/system-status",
        "/api/works",
        "/api/monitor-folders",
        "/api/system-settings",
        "/api/reader/preferences",
        "/api/download-tasks",
        "/api/import-tasks",
        "/api/sources",
        "/api/source-search-records",
        "/api/shelves",
        "/api/organize/jobs",
        "/api/organize/pending",
        "/api/backups",
        "/api/tracking/release-title-parser?title=Example%20Vol.3%20Ch.4",
    ]

    for endpoint in endpoints:
        response = client.get(endpoint)
        assert response.status_code == 200, endpoint
        payload = response.json()
        assert payload["ok"] is True, endpoint
        assert "data" in payload, endpoint


def test_organize_jobs_return_frontend_contract(client, db_session):
    create_worker_tables(db_session)
    create_organize_detail_tables(db_session)
    _login(client, db_session)
    db_session.execute(
        text(
            """INSERT INTO LibraryWork (
                id, title, normalizedTitle, author, normalizedAuthor, workType, status, publicationStatus,
                trackingStatus, tags, metadataQuality, organizeStatus, coverStatus, hidden, organized,
                mergeKey, createdAt, updatedAt
            ) VALUES (
                'work-contract', 'Contract Book', 'contractbook', '', '', 'EPUB', 'WANT', 'UNKNOWN', 'NOT_TRACKING',
                '[]', 20, 'REVIEWING', 'PENDING', 0, 0, 'epub:contract:', '2026-06-11T00:00:00', '2026-06-11T00:00:00'
            )"""
        )
    )
    db_session.execute(
        text(
            """INSERT INTO OrganizeJob (
                id, workId, status, issueCodes, summary, createdAt, updatedAt
            ) VALUES (
                'job-contract', 'work-contract', 'REVIEWING', '["MISSING_AUTHOR","SUGGEST_TITLE"]',
                'needs metadata', '2026-06-11T00:00:00', '2026-06-11T00:00:00'
            )"""
        )
    )
    db_session.execute(
        text(
            """INSERT INTO MetadataSuggestion (
                id, jobId, field, currentValue, suggestedValue, source, confidence, reason, status, createdAt, updatedAt
            ) VALUES (
                'suggest-contract', 'job-contract', 'title', '"Contract Book"', '"Better Contract Book"',
                'filename', 0.91, 'clean filename', 'PENDING', '2026-06-11T00:00:00', '2026-06-11T00:00:00'
            )"""
        )
    )
    db_session.execute(
        text(
            """INSERT INTO DuplicateCandidate (
                id, jobId, targetWorkId, reasons, confidence, suggestedAction, status, createdAt, updatedAt
            ) VALUES (
                'dup-contract', 'job-contract', 'work-other', '["title"]', 0.82,
                'KEEP_SEPARATE', 'PENDING', '2026-06-11T00:00:00', '2026-06-11T00:00:00'
            )"""
        )
    )
    db_session.commit()

    listed = client.get("/api/organize/jobs?pageSize=100")
    assert listed.status_code == 200
    list_payload = listed.json()["data"]
    job = next(item for item in list_payload["jobs"] if item["id"] == "job-contract")
    assert list_payload["books"][0]["id"] == "work-contract"
    assert list_payload["total"] == 1
    assert job["book"]["id"] == "work-contract"
    assert job["issueCodes"] == ["MISSING_AUTHOR", "SUGGEST_TITLE"]
    assert job["suggestions"][0]["suggestedValue"] == "Better Contract Book"
    assert job["duplicates"][0]["reasons"] == ["title"]

    detail = client.get("/api/organize/jobs/job-contract")
    assert detail.status_code == 200
    detail_job = detail.json()["data"]["job"]
    assert detail_job["book"]["title"] == "Contract Book"
    assert isinstance(detail_job["suggestions"], list)
    assert isinstance(detail_job["duplicates"], list)


def test_import_tasks_return_logs_summary_and_rescan_contract(client, db_session):
    create_worker_tables(db_session)
    _login(client, db_session)
    db_session.execute(
        text(
            """CREATE TABLE IF NOT EXISTS MonitorFolder (
                id TEXT PRIMARY KEY, name TEXT, rootPath TEXT, enabled BOOLEAN, importMode TEXT,
                ignorePatterns TEXT, ignoreHidden BOOLEAN, minFileSizeBytes INTEGER, description TEXT,
                createdAt TEXT, updatedAt TEXT
            )"""
        )
    )
    db_session.execute(text("CREATE TABLE IF NOT EXISTS SystemSetting (`key` TEXT PRIMARY KEY, `value` TEXT, `createdAt` TEXT, `updatedAt` TEXT)"))
    db_session.execute(
        text(
            """INSERT INTO MonitorFolder (
                id, name, rootPath, enabled, importMode, ignoreHidden, minFileSizeBytes, createdAt, updatedAt
            ) VALUES (
                'folder-1', 'Inbox', '/books/inbox', 1, 'COPY', 1, 1024, '2026-06-11T00:00:00', '2026-06-11T00:00:00'
            )"""
        )
    )
    db_session.execute(
        text(
            """INSERT INTO LibraryWork (
                id, title, normalizedTitle, author, normalizedAuthor, workType, status, publicationStatus,
                trackingStatus, tags, metadataQuality, organizeStatus, coverStatus, hidden, organized,
                mergeKey, createdAt, updatedAt
            ) VALUES (
                'work-import', 'Imported Book', 'importedbook', 'Author', 'author', 'EPUB', 'WANT', 'UNKNOWN',
                'NOT_TRACKING', '[]', 80, 'APPLIED', 'READY', 0, 1, 'epub:import:', '2026-06-11T00:00:00', '2026-06-11T00:00:00'
            )"""
        )
    )
    db_session.execute(
        text(
            """INSERT INTO ImportTask (
                id, monitorFolderId, workId, origin, status, originalName, sourcePath, managedFilePath,
                contentHash, progress, duplicate, errorSummary, message, createdAt, updatedAt
            ) VALUES (
                'import-1', 'folder-1', 'work-import', 'WATCH', 'FAILED', 'bad.zip',
                '/books/inbox/bad.zip', '/storage/library/bad.zip', 'hash-1', 100, 0,
                'invalid zip archive', '导入失败，详情见错误信息', '2026-06-11T00:00:00', '2026-06-11T00:00:00'
            )"""
        )
    )
    db_session.execute(text("INSERT INTO ImportLog (id, importTaskId, level, message, createdAt) VALUES ('log-1', 'import-1', 'error', 'invalid zip archive', '2026-06-11T00:00:01')"))
    db_session.commit()

    listed = client.get("/api/import-tasks")
    assert listed.status_code == 200
    data = listed.json()["data"]
    task = data["tasks"][0]
    assert data["summary"]["failed"] == 1
    assert task["sourcePath"] == "bad.zip"
    assert task["managedFilePath"] == "bad.zip"
    assert task["friendlyError"] == "压缩包可能损坏：请重新复制文件或用本地工具测试压缩包。"
    assert task["monitorFolder"]["name"] == "Inbox"
    assert task["book"] == {"id": "work-import", "title": "Imported Book"}
    assert task["logs"][0]["message"] == "invalid zip archive"

    detail = client.get("/api/import-tasks/import-1")
    assert detail.status_code == 200
    assert isinstance(detail.json()["data"]["task"]["logs"], list)

    logs = client.get("/api/import-tasks/import-1/logs?pageSize=1")
    assert logs.status_code == 200
    assert logs.json()["data"]["total"] == 1

    rescan = client.post("/api/import-tasks/rescan")
    assert rescan.status_code == 200
    assert rescan.json()["data"]["requestedAt"]
    assert db_session.execute(text("SELECT `value` FROM SystemSetting WHERE `key` = 'monitor.rescanRequestedAt'")).scalar()


def test_monitor_folder_and_system_settings_mutations(client, db_session, test_settings):
    test_settings.resolved_monitor_root.mkdir(parents=True)
    second_root = test_settings.resolved_monitor_root.parent / "second-inbox"
    second_root.mkdir(parents=True)
    _login(client, db_session)

    created = client.post(
        "/api/monitor-folders",
        json={"name": "Inbox", "rootPath": str(test_settings.resolved_monitor_root), "enabled": True},
    )
    assert created.status_code == 201
    folder_id = created.json()["data"]["folder"]["id"]

    duplicate = client.post(
        "/api/monitor-folders",
        json={"name": "Duplicate Inbox", "rootPath": f"{test_settings.resolved_monitor_root}/", "enabled": True},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["ok"] is False

    empty_path = client.post("/api/monitor-folders", json={"name": "No Path", "rootPath": " "})
    assert empty_path.status_code == 400
    assert empty_path.json()["ok"] is False

    second = client.post(
        "/api/monitor-folders",
        json={"name": "Second Inbox", "rootPath": str(second_root), "enabled": True},
    )
    assert second.status_code == 201
    second_folder_id = second.json()["data"]["folder"]["id"]

    collision = client.put(f"/api/monitor-folders/{second_folder_id}", json={"rootPath": str(test_settings.resolved_monitor_root)})
    assert collision.status_code == 409
    assert collision.json()["ok"] is False

    updated = client.put(f"/api/monitor-folders/{folder_id}", json={"enabled": False, "importMode": "MOVE"})
    assert updated.status_code == 200
    assert updated.json()["data"]["folder"]["enabled"] is False
    assert updated.json()["data"]["folder"]["updatedAt"]

    settings = client.put("/api/system-settings", json={"settings": {"readerTheme": "dark"}})
    assert settings.status_code == 200
    assert settings.json()["data"]["settings"]["readerTheme"] == "dark"


def test_monitor_folder_move_requires_writable_root(client, db_session, test_settings, monkeypatch):
    test_settings.resolved_monitor_root.mkdir(parents=True)
    _login(client, db_session)
    monkeypatch.setattr(compat.os, "access", lambda _path, mode: False if mode == compat.os.W_OK else True)

    created = client.post(
        "/api/monitor-folders",
        json={"name": "Read Only Inbox", "rootPath": str(test_settings.resolved_monitor_root), "enabled": True, "importMode": "MOVE"},
    )

    assert created.status_code == 400
    assert created.json()["ok"] is False
    assert "移动模式需要监控文件夹可写" in created.json()["error"]["message"]


def test_source_manual_and_http_providers_execute_search_and_save_records(client, db_session):
    create_source_tables(db_session)
    _login(client, db_session)

    manual = client.post(
        "/api/sources",
        json={
            "name": "Manual shelf",
            "kind": "mixed",
            "providerType": "manual",
            "config": {
                "items": [
                    {"externalId": "m-1", "title": "Star Manual", "author": "Guide", "format": "EPUB"},
                    {"externalId": "m-2", "title": "Other Book", "author": "Guide"},
                ]
            },
        },
    )
    assert manual.status_code == 201
    manual_id = manual.json()["data"]["source"]["id"]

    tested = client.post(f"/api/sources/{manual_id}/test")
    assert tested.status_code == 200
    assert tested.json()["data"]["result"]["status"] == "ok"
    assert "可搜索 2 条" in tested.json()["data"]["result"]["message"]

    searched = client.post(f"/api/sources/{manual_id}/search", json={"keyword": "star", "saveResults": True})
    assert searched.status_code == 200
    search_data = searched.json()["data"]
    assert search_data["provider"]["providerType"] == "manual"
    assert len(search_data["results"]) == 1
    assert search_data["results"][0]["externalId"] == "m-1"
    assert search_data["records"][0]["status"] == "saved"

    repeated = client.post(f"/api/sources/{manual_id}/search", json={"keyword": "star", "saveResults": True})
    assert repeated.status_code == 200
    assert db_session.execute(text("SELECT COUNT(*) FROM SourceSearchRecord WHERE sourceId = :source_id"), {"source_id": manual_id}).scalar() == 1

    http_source = client.post(
        "/api/sources",
        json={
            "name": "HTTP shelf",
            "providerType": "http",
            "config": {
                "items": [
                    {"externalId": "h-1", "title": "Space PDF", "downloadUrl": "https://example.com/space.pdf", "format": "PDF"},
                    {"externalId": "h-2", "title": "Bad URL", "downloadUrl": "ftp://example.com/bad.pdf"},
                ]
            },
        },
    )
    assert http_source.status_code == 201
    http_id = http_source.json()["data"]["source"]["id"]

    http_test = client.post(f"/api/sources/{http_id}/test")
    assert http_test.status_code == 200
    assert http_test.json()["data"]["result"]["status"] == "failed"
    assert "有效 downloadUrl" in http_test.json()["data"]["result"]["message"]

    http_search = client.post(f"/api/sources/{http_id}/search", json={"keyword": "space"})
    assert http_search.status_code == 200
    assert http_search.json()["data"]["results"][0]["downloadMeta"]["type"] == "http"


def test_pt_rss_provider_search_saves_record_and_creates_download_task(client, db_session, tmp_path):
    create_source_tables(db_session)
    create_download_tables(db_session)
    _login(client, db_session)
    feed_dir = tmp_path / "rss"
    feed_dir.mkdir()
    (feed_dir / "feed.xml").write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Star Volume 01</title>
      <link>http://tracker.example/details/1?passkey=secret&amp;view=full</link>
      <guid>torrent-1</guid>
      <pubDate>Tue, 01 Jan 2030 10:00:00 GMT</pubDate>
      <category>Manga</category>
      <enclosure url="http://tracker.example/download/1.torrent?passkey=secret" type="application/x-bittorrent" length="1234" />
    </item>
    <item>
      <title>Star Skip Volume</title>
      <link>http://tracker.example/details/skip</link>
      <guid>torrent-skip</guid>
      <category>Manga</category>
    </item>
    <item>
      <title>Star Volume Novel</title>
      <link>http://tracker.example/details/novel</link>
      <guid>torrent-novel</guid>
      <category>Novel</category>
    </item>
  </channel>
</rss>
""",
        encoding="utf-8",
    )
    server = serve_directory(feed_dir)
    try:
        source = client.post(
            "/api/sources",
            json={
                "name": "PT feed",
                "providerType": "pt_rss",
                "config": {
                    "rssUrl": f"http://127.0.0.1:{server.server_port}/feed.xml",
                    "keywordInclude": ["Star"],
                    "keywordExclude": ["Skip"],
                    "category": "Manga",
                    "defaultType": "comic",
                },
            },
        )
        assert source.status_code == 201
        source_id = source.json()["data"]["source"]["id"]

        tested = client.post(f"/api/sources/{source_id}/test")
        assert tested.status_code == 200
        test_result = tested.json()["data"]["result"]
        assert test_result["status"] == "ok"
        assert "RSS 可读取" in test_result["message"]
        assert len(test_result["details"]["preview"]) == 3

        searched = client.post(f"/api/sources/{source_id}/search", json={"keyword": "Star", "saveResults": True})
        assert searched.status_code == 200
        data = searched.json()["data"]
        assert data["provider"]["providerType"] == "pt_rss"
        assert len(data["results"]) == 1
        result = data["results"][0]
        assert result["externalId"] == "torrent-1"
        assert result["format"] == "comic"
        assert result["externalUrl"] == "http://tracker.example/details/1?passkey=REDACTED&view=full"
        assert result["downloadAvailable"] is True
        assert result["downloadMeta"]["kind"] == "torrent"
        assert result["downloadMeta"]["downloadUrl"].endswith("/1.torrent?passkey=secret")

        record = data["records"][0]
        assert record["status"] == "saved"
        assert json.loads(record["downloadMeta"])["kind"] == "torrent"

        task_response = client.post(f"/api/source-search-records/{record['id']}/create-download-task")
        assert task_response.status_code == 201
        task = task_response.json()["data"]["task"]
        assert task["type"] == "http"
        assert task["sourceId"] == source_id
        assert task["searchRecordId"] == record["id"]
        assert json.loads(task["remoteRef"])["downloadMeta"]["kind"] == "torrent"
    finally:
        server.shutdown()


def test_generic_rss_and_comic_api_providers_create_download_tasks(client, db_session, tmp_path):
    create_source_tables(db_session)
    create_download_tables(db_session)
    _login(client, db_session)
    feed_dir = tmp_path / "generic-rss"
    feed_dir.mkdir()
    (feed_dir / "feed.xml").write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Orbital EPUB Dispatch</title>
      <link>http://example.test/books/orbital</link>
      <guid>rss-book-1</guid>
      <pubDate>Wed, 02 Jan 2030 10:00:00 GMT</pubDate>
      <category>Novel</category>
      <enclosure url="http://example.test/downloads/orbital.epub" type="application/epub+zip" length="4096" />
    </item>
    <item>
      <title>Other Dispatch</title>
      <link>http://example.test/books/other</link>
      <guid>rss-book-2</guid>
      <category>Novel</category>
    </item>
  </channel>
</rss>
""",
        encoding="utf-8",
    )
    server = serve_directory(feed_dir)
    try:
        rss_source = client.post(
            "/api/sources",
            json={"name": "Generic RSS", "kind": "novel", "providerType": "rss", "config": {"rssUrl": f"http://127.0.0.1:{server.server_port}/feed.xml"}},
        )
        assert rss_source.status_code == 201
        rss_id = rss_source.json()["data"]["source"]["id"]

        rss_test = client.post(f"/api/sources/{rss_id}/test")
        assert rss_test.status_code == 200
        assert rss_test.json()["data"]["result"]["status"] == "ok"

        rss_search = client.post(f"/api/sources/{rss_id}/search", json={"keyword": "Orbital", "saveResults": True})
        assert rss_search.status_code == 200
        rss_data = rss_search.json()["data"]
        assert rss_data["provider"]["providerType"] == "rss"
        assert rss_data["results"][0]["format"] == "ebook"
        assert rss_data["results"][0]["downloadMeta"]["type"] == "http"
        assert rss_data["results"][0]["downloadMeta"]["downloadUrl"].endswith("/orbital.epub")

        rss_record = rss_data["records"][0]
        rss_task = client.post(f"/api/source-search-records/{rss_record['id']}/create-download-task")
        assert rss_task.status_code == 201
        assert rss_task.json()["data"]["task"]["type"] == "http"

        comic_source = client.post(
            "/api/sources",
            json={
                "name": "Comic API",
                "kind": "comic",
                "providerType": "comic_api",
                "config": {
                    "items": [
                        {"id": "comic-1", "title": "Orbital Frames 01", "series": "Orbital Frames", "downloadUrl": "https://example.test/comics/orbital-01.cbz"},
                        {"id": "comic-2", "title": "Quiet Frames", "downloadUrl": "https://example.test/comics/quiet.cbz"},
                    ]
                },
            },
        )
        assert comic_source.status_code == 201
        comic_id = comic_source.json()["data"]["source"]["id"]

        comic_test = client.post(f"/api/sources/{comic_id}/test")
        assert comic_test.status_code == 200
        assert comic_test.json()["data"]["result"]["status"] == "ok"

        comic_search = client.post(f"/api/sources/{comic_id}/search", json={"keyword": "Orbital", "saveResults": True})
        assert comic_search.status_code == 200
        comic_data = comic_search.json()["data"]
        assert comic_data["provider"]["providerType"] == "comic_api"
        assert comic_data["provider"]["capabilities"]["api"] is True
        assert comic_data["results"][0]["externalId"] == "comic-1"
        assert comic_data["results"][0]["format"] == "comic"
        assert comic_data["results"][0]["downloadMeta"]["downloadUrl"].endswith("/orbital-01.cbz")

        comic_record = comic_data["records"][0]
        comic_task = client.post(f"/api/source-search-records/{comic_record['id']}/create-download-task")
        assert comic_task.status_code == 201
        assert comic_task.json()["data"]["task"]["type"] == "http"
    finally:
        server.shutdown()


def test_create_download_task_only_queues_without_downloading(client, db_session, test_settings, tmp_path):
    create_source_tables(db_session)
    create_download_tables(db_session)
    test_settings.resolved_download_inbox_path.mkdir(parents=True)
    _login(client, db_session)
    source_dir = tmp_path / "queue-source"
    source_dir.mkdir()
    (source_dir / "book.epub").write_bytes(b"queued-book")
    server = serve_directory(source_dir)
    try:
        created = client.post(
            "/api/sources",
            json={
                "name": "HTTP queue source",
                "providerType": "http",
                "config": {"items": [{"externalId": "queue-1", "title": "Queue Book", "downloadUrl": f"http://127.0.0.1:{server.server_port}/book.epub"}]},
            },
        )
        assert created.status_code == 201
        source_id = created.json()["data"]["source"]["id"]

        searched = client.post(f"/api/sources/{source_id}/search", json={"keyword": "queue", "saveResults": True})
        assert searched.status_code == 200
        record = searched.json()["data"]["records"][0]

        queued = client.post(f"/api/source-search-records/{record['id']}/create-download-task")
        assert queued.status_code == 201
        task = queued.json()["data"]["task"]
        assert task["status"] == "queued"
        assert task["type"] == "http"
        assert not test_settings.resolved_download_inbox_path.joinpath("book.epub").exists()
    finally:
        server.shutdown()


def test_zlibrary_provider_search_masks_password_and_downloads_with_eapi(client, db_session, test_settings):
    create_source_tables(db_session)
    create_download_tables(db_session)
    test_settings.resolved_download_inbox_path.mkdir(parents=True)
    _login(client, db_session)
    server = serve_zlibrary_eapi()
    try:
        base_url = f"http://127.0.0.1:{server.server_port}"
        created = client.post(
            "/api/sources",
            json={
                "name": "Z-Library",
                "kind": "novel",
                "providerType": "zlibrary",
                "config": {"email": "reader@example.com", "password": "secret", "baseUrl": base_url, "languages": ["english"], "extensions": ["EPUB"], "exact": True, "pageSize": 10},
            },
        )
        assert created.status_code == 201
        source = created.json()["data"]["source"]
        assert source["providerTypeLabel"] == "Z-Library"
        assert source["config"]["password"]["configured"] is True
        source_id = source["id"]

        listed = client.get("/api/sources")
        assert listed.status_code == 200
        assert listed.json()["data"]["sources"][0]["config"]["password"]["masked"] == "********"

        updated = client.put(f"/api/sources/{source_id}", json={"config": {"email": "reader@example.com", "password": "", "baseUrl": base_url, "languages": ["english"], "extensions": ["EPUB"], "exact": False, "pageSize": 20}})
        assert updated.status_code == 200
        stored_config = json.loads(db_session.execute(text("SELECT config FROM Source WHERE id = :id"), {"id": source_id}).scalar())
        assert stored_config["password"] == "secret"
        assert stored_config["baseUrl"] == base_url

        tested = client.post(f"/api/sources/{source_id}/test")
        assert tested.status_code == 200
        test_result = tested.json()["data"]["result"]
        assert test_result["status"] == "ok"
        assert test_result["details"]["baseUrl"] == base_url

        searched = client.post(f"/api/sources/{source_id}/search", json={"keyword": "orbital", "saveResults": True})
        assert searched.status_code == 200
        data = searched.json()["data"]
        assert data["provider"]["providerType"] == "zlibrary"
        result = data["results"][0]
        assert result["providerType"] == "zlibrary"
        assert result["externalId"] == "zlibrary:123"
        assert result["downloadAvailable"] is True
        assert result["downloadMeta"]["type"] == "zlibrary_eapi"
        assert result["downloadMeta"]["zlibraryBookId"] == "123"
        assert result["downloadMeta"]["zlibraryBookHash"] == "abc123"
        assert result["downloadMeta"]["filename"] == "Orbital Mechanics.epub"

        record = data["records"][0]
        task = client.post(f"/api/source-search-records/{record['id']}/create-download-task")
        assert task.status_code == 201
        task_payload = task.json()["data"]["task"]
        assert task_payload["type"] == "zlibrary"

        started = client.post(f"/api/download-tasks/{task_payload['id']}/start")
        assert started.status_code == 200
        downloaded_task = started.json()["data"]["task"]
        assert downloaded_task["status"] == "downloaded"
        assert downloaded_task["filePath"].endswith("orbital.epub")
        assert test_settings.resolved_download_inbox_path.joinpath("orbital.epub").read_bytes() == b"zlibrary-epub"
        assert any(item["path"] == "/eapi/book/123/abc123/file" and "remix_userid=user-1" in (item["cookie"] or "") for item in server.requests)
    finally:
        server.shutdown()


def test_telegram_provider_is_no_longer_supported(client, db_session):
    create_source_tables(db_session)
    _login(client, db_session)
    created = client.post(
        "/api/sources",
        json={"name": "Old Telegram", "kind": "novel", "providerType": "telegram", "config": {"botUsername": "@zlib_test_bot"}},
    )
    assert created.status_code == 201
    source_id = created.json()["data"]["source"]["id"]

    tested = client.post(f"/api/sources/{source_id}/test")
    assert tested.status_code == 200
    assert tested.json()["data"]["result"]["status"] == "failed"
    assert "尚未实现 Provider" in tested.json()["data"]["result"]["message"]

    searched = client.post(f"/api/sources/{source_id}/search", json={"keyword": "orbital"})
    assert searched.status_code == 400
    assert "尚未实现 Provider" in searched.json()["error"]["message"]


def test_zlibrary_login_errors_return_search_failure(client, db_session):
    create_source_tables(db_session)
    _login(client, db_session)
    server = serve_zlibrary_eapi("bad_login")
    try:
        created = client.post(
            "/api/sources",
            json={
                "name": "Z-Library",
                "kind": "novel",
                "providerType": "zlibrary",
                "config": {"email": "reader@example.com", "password": "bad", "baseUrl": f"http://127.0.0.1:{server.server_port}"},
            },
        )
        assert created.status_code == 201
        source_id = created.json()["data"]["source"]["id"]

        searched = client.post(f"/api/sources/{source_id}/search", json={"keyword": "orbital"})
        assert searched.status_code == 400
        assert "邮箱或密码不正确" in searched.json()["error"]["message"]
    finally:
        server.shutdown()


def test_zlibrary_browser_check_page_returns_actionable_error(client, db_session):
    create_source_tables(db_session)
    _login(client, db_session)
    server = serve_zlibrary_eapi("browser_check")
    try:
        created = client.post(
            "/api/sources",
            json={
                "name": "Z-Library",
                "kind": "novel",
                "providerType": "zlibrary",
                "config": {"email": "reader@example.com", "password": "secret", "baseUrl": f"http://127.0.0.1:{server.server_port}"},
            },
        )
        assert created.status_code == 201
        source_id = created.json()["data"]["source"]["id"]

        searched = client.post(f"/api/sources/{source_id}/search", json={"keyword": "orbital"})
        assert searched.status_code == 400
        assert "浏览器校验页" in searched.json()["error"]["message"]
    finally:
        server.shutdown()


def test_download_task_http_start_downloads_file(client, db_session, test_settings, tmp_path):
    create_download_tables(db_session)
    test_settings.resolved_download_inbox_path.mkdir(parents=True)
    _login(client, db_session)
    source_dir = tmp_path / "http"
    source_dir.mkdir()
    (source_dir / "book.epub").write_bytes(b"downloaded-book")
    server = serve_directory(source_dir)
    try:
        url = f"http://127.0.0.1:{server.server_port}/book.epub"
        created = client.post(
            "/api/download-tasks",
            json={"type": "http", "displayName": "book.epub", "remoteRef": {"downloadUrl": url}},
        )
        assert created.status_code == 201
        task_id = created.json()["data"]["task"]["id"]

        started = client.post(f"/api/download-tasks/{task_id}/start")
        assert started.status_code == 200
        task = started.json()["data"]["task"]
        assert task["status"] == "downloaded"
        assert task["progress"] == 100
        assert task["filePath"].endswith("book.epub")
        assert test_settings.resolved_download_inbox_path.joinpath("book.epub").read_bytes() == b"downloaded-book"
    finally:
        server.shutdown()


def test_download_queue_worker_downloads_and_imports_http_task(client, db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    create_download_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    test_settings.resolved_download_inbox_path.mkdir(parents=True)
    _login(client, db_session)
    source_dir = tmp_path / "queue-http"
    source_dir.mkdir()
    write_epub_fixture(source_dir / "queued.epub")
    server = serve_directory(source_dir)
    try:
        created = client.post(
            "/api/download-tasks",
            json={"type": "http", "displayName": "queued.epub", "remoteRef": {"downloadUrl": f"http://127.0.0.1:{server.server_port}/queued.epub"}},
        )
        assert created.status_code == 201
        task_id = created.json()["data"]["task"]["id"]

        assert process_next_download_task(db_session, test_settings) is True

        task = db_session.execute(text("SELECT * FROM DownloadTask WHERE id = :id"), {"id": task_id}).mappings().first()
        assert task["status"] == "completed"
        assert task["bookId"]
        assert task["filePath"].endswith("queued.epub")
        assert test_settings.resolved_download_inbox_path.joinpath("queued.epub").exists()
        assert db_session.execute(text("SELECT COUNT(*) FROM LibraryWork")).scalar() == 1
    finally:
        server.shutdown()


def test_download_queue_worker_marks_download_failures(client, db_session, test_settings):
    create_download_tables(db_session)
    test_settings.resolved_download_inbox_path.mkdir(parents=True)
    _login(client, db_session)
    created = client.post(
        "/api/download-tasks",
        json={"type": "http", "displayName": "bad.epub", "remoteRef": {"downloadUrl": "ftp://example.com/bad.epub"}},
    )
    assert created.status_code == 201
    task_id = created.json()["data"]["task"]["id"]

    assert process_next_download_task(db_session, test_settings) is True

    task = db_session.execute(text("SELECT status, errorMessage FROM DownloadTask WHERE id = :id"), {"id": task_id}).mappings().first()
    assert task["status"] == "failed"
    assert "http/https" in task["errorMessage"]


def test_download_task_retry_requeues_cancelled_task(client, db_session):
    create_download_tables(db_session)
    _login(client, db_session)
    created = client.post(
        "/api/download-tasks",
        json={"type": "http", "displayName": "retry.epub", "remoteRef": {"downloadUrl": "https://example.com/retry.epub"}},
    )
    assert created.status_code == 201
    task_id = created.json()["data"]["task"]["id"]

    cancelled = client.post(f"/api/download-tasks/{task_id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["data"]["task"]["status"] == "cancelled"

    retried = client.post(f"/api/download-tasks/{task_id}/retry")
    assert retried.status_code == 200
    payload = retried.json()["data"]["task"]
    assert payload["status"] == "queued"
    assert payload["progress"] == 0


def test_download_task_torrent_execution(client, db_session, test_settings, tmp_path):
    create_download_tables(db_session)
    test_settings.resolved_download_inbox_path.mkdir(parents=True)
    _login(client, db_session)
    torrent_dir = tmp_path / "torrent"
    torrent_dir.mkdir()
    (torrent_dir / "book.torrent").write_bytes(b"d8:announce")
    server = serve_directory(torrent_dir)
    try:
        torrent_url = f"http://127.0.0.1:{server.server_port}/book.torrent"
        torrent_task = client.post(
            "/api/download-tasks",
            json={"type": "torrent", "displayName": "book", "remoteRef": {"torrentUrl": torrent_url, "filename": "book.torrent"}},
        )
        assert torrent_task.status_code == 201
        torrent_started = client.post(f"/api/download-tasks/{torrent_task.json()['data']['task']['id']}/start")
        assert torrent_started.status_code == 200
        torrent_payload = torrent_started.json()["data"]["task"]
        assert torrent_payload["status"] == "downloaded"
        assert torrent_payload["filePath"].endswith("book.torrent")
        assert test_settings.resolved_download_inbox_path.joinpath("book.torrent").read_bytes() == b"d8:announce"

        magnet_task = client.post(
            "/api/download-tasks",
            json={"type": "torrent", "displayName": "magnet-book", "remoteRef": {"magnetUrl": "magnet:?xt=urn:btih:abc123"}},
        )
        assert magnet_task.status_code == 201
        magnet_started = client.post(f"/api/download-tasks/{magnet_task.json()['data']['task']['id']}/start")
        assert magnet_started.status_code == 200
        magnet_payload = magnet_started.json()["data"]["task"]
        assert magnet_payload["status"] == "downloaded"
        assert magnet_payload["filePath"].endswith(".magnet")
        assert "magnet:?xt=urn:btih:abc123" in test_settings.resolved_download_inbox_path.joinpath("magnet-book.magnet").read_text(encoding="utf-8")
    finally:
        server.shutdown()


def test_download_task_torrent_submits_to_qbittorrent_when_configured(client, db_session, test_settings):
    create_download_tables(db_session)
    test_settings.resolved_download_inbox_path.mkdir(parents=True)
    _login(client, db_session)
    qbit = serve_qbittorrent_api()
    test_settings.qbittorrent_url = f"http://127.0.0.1:{qbit.server_port}"
    test_settings.qbittorrent_username = "admin"
    test_settings.qbittorrent_password = "secret"
    test_settings.qbittorrent_category = "shuku"
    test_settings.qbittorrent_save_path = "/downloads/books"
    try:
        magnet_task = client.post(
            "/api/download-tasks",
            json={"type": "torrent", "displayName": "magnet-book", "remoteRef": {"magnetUrl": "magnet:?xt=urn:btih:abc123"}},
        )

        assert magnet_task.status_code == 201
        magnet_started = client.post(f"/api/download-tasks/{magnet_task.json()['data']['task']['id']}/start")

        assert magnet_started.status_code == 200
        task = magnet_started.json()["data"]["task"]
        assert task["status"] == "downloaded"
        assert task["filePath"].endswith(".qbittorrent.json")
        assert qbit.requests[0]["path"] == "/api/v2/auth/login"
        assert qbit.requests[0]["form"] == {"username": "admin", "password": "secret"}
        assert qbit.requests[1]["path"] == "/api/v2/torrents/add"
        assert qbit.requests[1]["cookie"] == "SID=test-session"
        assert qbit.requests[1]["form"]["urls"] == "magnet:?xt=urn:btih:abc123"
        assert qbit.requests[1]["form"]["category"] == "shuku"
        assert qbit.requests[1]["form"]["savepath"] == "/downloads/books"
        manifest = json.loads(test_settings.resolved_download_inbox_path.joinpath("magnet-book.qbittorrent.json").read_text(encoding="utf-8"))
        assert manifest["type"] == "qbittorrent_submission"
        assert manifest["refType"] == "magnetUrl"
        assert manifest["category"] == "shuku"
    finally:
        qbit.shutdown()


def test_download_task_qbittorrent_completed_file_imports_with_python_importer(client, db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    create_download_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    test_settings.resolved_download_inbox_path.mkdir(parents=True)
    qbit_save = tmp_path / "qbit-completed"
    qbit_save.mkdir()
    test_settings.qbittorrent_save_path = str(qbit_save)
    _login(client, db_session)
    completed = qbit_save / "magnet-book.epub"
    write_epub_fixture(completed)
    manifest = test_settings.resolved_download_inbox_path / "magnet-book.qbittorrent.json"
    manifest.write_text(
        json.dumps(
            {
                "type": "qbittorrent_submission",
                "taskId": "task-qbit",
                "title": "magnet-book",
                "refType": "magnetUrl",
                "ref": "magnet:?xt=urn:btih:abc123",
                "savePath": str(qbit_save),
                "expectedName": "magnet-book",
            }
        ),
        encoding="utf-8",
    )

    created = client.post(
        "/api/download-tasks",
        json={"type": "torrent", "status": "downloaded", "displayName": "magnet-book", "filePath": str(manifest)},
    )
    assert created.status_code == 201
    task_id = created.json()["data"]["task"]["id"]

    imported = client.post(f"/api/download-tasks/{task_id}/import")

    assert imported.status_code == 200
    payload = imported.json()["data"]
    assert payload["task"]["status"] == "completed"
    assert payload["task"]["filePath"].endswith("magnet-book.epub")
    assert payload["importResult"]["type"] == "ebook"
    assert (test_settings.resolved_download_inbox_path / "magnet-book.epub").exists()
    assert db_session.execute(text("SELECT COUNT(*) FROM LibraryWork")).scalar() == 1


def test_download_task_import_uses_python_importer(client, db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    create_download_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    test_settings.resolved_download_inbox_path.mkdir(parents=True)
    _login(client, db_session)
    epub = test_settings.resolved_download_inbox_path / "downloaded.epub"
    write_epub_fixture(epub)

    created = client.post(
        "/api/download-tasks",
        json={"type": "http", "status": "downloaded", "displayName": "downloaded.epub", "filePath": str(epub)},
    )
    assert created.status_code == 201
    task_id = created.json()["data"]["task"]["id"]

    imported = client.post(f"/api/download-tasks/{task_id}/import")
    assert imported.status_code == 200
    payload = imported.json()["data"]
    assert payload["task"]["status"] == "completed"
    assert payload["task"]["bookId"] == payload["importResult"]["bookId"]
    assert payload["importResult"]["type"] == "ebook"
    assert db_session.execute(text("SELECT COUNT(*) FROM LibraryWork")).scalar() == 1


def test_download_task_import_pdf_uses_python_importer(client, db_session, test_settings):
    create_worker_tables(db_session)
    create_download_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    test_settings.resolved_download_inbox_path.mkdir(parents=True)
    _login(client, db_session)
    pdf = test_settings.resolved_download_inbox_path / "downloaded.pdf"
    write_pdf_fixture(pdf)

    created = client.post(
        "/api/download-tasks",
        json={"type": "http", "status": "downloaded", "displayName": "downloaded.pdf", "filePath": str(pdf)},
    )
    assert created.status_code == 201
    task_id = created.json()["data"]["task"]["id"]

    imported = client.post(f"/api/download-tasks/{task_id}/import")
    assert imported.status_code == 200
    payload = imported.json()["data"]
    assert payload["task"]["status"] == "completed"
    assert payload["importResult"]["format"] == "pdf"
    assert db_session.execute(text("SELECT mimeType FROM LibraryFile")).scalar() == "application/pdf"


def test_organize_apply_updates_work_from_metadata_suggestions(client, db_session):
    create_worker_tables(db_session)
    create_organize_detail_tables(db_session)
    _login(client, db_session)
    db_session.execute(
        text(
            """INSERT INTO LibraryWork (
                id, title, normalizedTitle, author, normalizedAuthor, workType, status, publicationStatus,
                trackingStatus, tags, metadataQuality, organizeStatus, coverStatus, hidden, organized,
                mergeKey, createdAt, updatedAt
            ) VALUES (
                'work-1', 'old.pdf', 'oldpdf', '', '', 'PDF', 'WANT', 'UNKNOWN', 'NOT_TRACKING',
                '[]', 0, 'REVIEWING', 'PENDING', 0, 0, 'pdf:old:', 'now', 'now'
            )"""
        )
    )
    db_session.execute(text("INSERT INTO OrganizeJob (id, workId, status, issueCodes, createdAt, updatedAt) VALUES ('job-1', 'work-1', 'REVIEWING', '[]', 'now', 'now')"))
    db_session.execute(text("INSERT INTO MetadataSuggestion (id, jobId, field, currentValue, suggestedValue, source, confidence, reason, status, createdAt, updatedAt) VALUES ('s-title', 'job-1', 'title', 'old.pdf', 'New Title', 'filename', 0.95, 'clean filename', 'PENDING', 'now', 'now')"))
    db_session.execute(text("INSERT INTO MetadataSuggestion (id, jobId, field, currentValue, suggestedValue, source, confidence, reason, status, createdAt, updatedAt) VALUES ('s-author', 'job-1', 'author', '', 'Author A', 'embedded', 0.90, 'metadata', 'PENDING', 'now', 'now')"))
    db_session.commit()

    applied = client.post("/api/organize/jobs/job-1/apply", json={"highConfidenceOnly": True, "markOrganized": True})

    assert applied.status_code == 200
    payload = applied.json()["data"]
    assert payload["applied"] == 2
    work = db_session.execute(text("SELECT title, author, organized, organizeStatus FROM LibraryWork WHERE id = 'work-1'")).mappings().first()
    assert dict(work) == {"title": "New Title", "author": "Author A", "organized": 1, "organizeStatus": "APPLIED"}
    assert db_session.execute(text("SELECT COUNT(*) FROM MetadataSuggestion WHERE status = 'APPLIED'")).scalar() == 2


def test_organize_apply_duplicate_actions_merge_versions_and_hide_sources(client, db_session):
    create_worker_tables(db_session)
    create_organize_detail_tables(db_session)
    _login(client, db_session)
    for work_id, title in [("work-main", "Main Title"), ("work-merge", "Merge Candidate"), ("work-hide", "Hide Candidate")]:
        db_session.execute(
            text(
                """INSERT INTO LibraryWork (
                    id, title, normalizedTitle, author, normalizedAuthor, workType, status, publicationStatus,
                    trackingStatus, tags, metadataQuality, organizeStatus, coverStatus, hidden, organized,
                    primaryEditionId, mergeKey, createdAt, updatedAt
                ) VALUES (
                    :id, :title, :normalized, '', '', 'EPUB', 'WANT', 'UNKNOWN', 'NOT_TRACKING',
                    '[]', 0, 'REVIEWING', 'PENDING', 0, 0, :primary_edition_id, :merge_key, 'now', 'now'
                )"""
            ),
            {
                "id": work_id,
                "title": title,
                "normalized": title.lower().replace(" ", ""),
                "primary_edition_id": f"edition-{work_id}",
                "merge_key": f"epub:{work_id}",
            },
        )
        db_session.execute(
            text(
                """INSERT INTO LibraryEdition (
                    id, workId, origin, format, versionName, versionKey, importStatus, sizeBytes, "primary", hidden, createdAt, updatedAt
                ) VALUES (:id, :work_id, 'MANUAL', 'EPUB', :version_name, :version_key, 'IMPORTED', 10, 1, 0, 'now', 'now')"""
            ),
            {"id": f"edition-{work_id}", "work_id": work_id, "version_name": title, "version_key": f"version-{work_id}"},
        )
    db_session.execute(text("INSERT INTO OrganizeJob (id, workId, editionId, status, issueCodes, createdAt, updatedAt) VALUES ('job-dup', 'work-main', 'edition-work-main', 'REVIEWING', '[]', 'now', 'now')"))
    db_session.execute(text("INSERT INTO DuplicateCandidate (id, jobId, targetWorkId, reasons, confidence, suggestedAction, status, createdAt, updatedAt) VALUES ('dup-merge', 'job-dup', 'work-merge', '[\"title\"]', 0.84, 'MERGE_AS_VERSION', 'PENDING', 'now', 'now')"))
    db_session.execute(text("INSERT INTO DuplicateCandidate (id, jobId, targetWorkId, reasons, confidence, suggestedAction, status, createdAt, updatedAt) VALUES ('dup-hide', 'job-dup', 'work-hide', '[\"hash\"]', 1.0, 'HIDE_DUPLICATE', 'PENDING', 'now', 'now')"))
    db_session.commit()

    applied = client.post("/api/organize/jobs/job-dup/apply", json={"duplicateIds": ["dup-merge", "dup-hide"]})

    assert applied.status_code == 200
    payload = applied.json()["data"]
    assert payload["duplicateActionsApplied"] == 2
    assert db_session.execute(text("SELECT workId FROM LibraryEdition WHERE id = 'edition-work-merge'")).scalar() == "work-main"
    assert db_session.execute(text("SELECT \"primary\" FROM LibraryEdition WHERE id = 'edition-work-merge'")).scalar() == 0
    assert db_session.execute(text("SELECT hidden FROM LibraryWork WHERE id = 'work-merge'")).scalar() == 1
    assert db_session.execute(text("SELECT hidden FROM LibraryWork WHERE id = 'work-hide'")).scalar() == 1
    assert db_session.execute(text("SELECT COUNT(*) FROM DuplicateCandidate WHERE status = 'APPLIED'")).scalar() == 2


def test_organize_refresh_recomputes_issues_and_duplicates(client, db_session):
    create_worker_tables(db_session)
    create_organize_detail_tables(db_session)
    _login(client, db_session)
    for work_id, title in [("work-a", "Same Title"), ("work-b", "Same Title")]:
        db_session.execute(
            text(
                """INSERT INTO LibraryWork (
                    id, title, normalizedTitle, author, normalizedAuthor, workType, status, publicationStatus,
                    trackingStatus, tags, metadataQuality, organizeStatus, coverStatus, hidden, organized,
                    mergeKey, createdAt, updatedAt
                ) VALUES (
                    :id, :title, :normalized, '', '', 'EPUB', 'WANT', 'UNKNOWN', 'NOT_TRACKING',
                    '[]', 0, 'REVIEWING', 'PENDING', 0, 0, :merge_key, 'now', 'now'
                )"""
            ),
            {"id": work_id, "title": title, "normalized": title.lower().replace(" ", ""), "merge_key": f"epub:{work_id}"},
        )
    db_session.execute(text("INSERT INTO OrganizeJob (id, workId, status, issueCodes, createdAt, updatedAt) VALUES ('job-refresh', 'work-a', 'REVIEWING', '[]', 'now', 'now')"))
    db_session.commit()

    refreshed = client.post("/api/organize/jobs/job-refresh/refresh", json={})

    assert refreshed.status_code == 200
    data = refreshed.json()["data"]
    assert data["job"]["duplicateCount"] == 1
    assert "DUPLICATE" in data["job"]["issueCodes"]
    assert db_session.execute(text("SELECT COUNT(*) FROM DuplicateCandidate WHERE jobId = 'job-refresh' AND targetWorkId = 'work-b'")).scalar() == 1


def test_work_metadata_refresh_runs_ai_provider_and_persists_suggestions(client, db_session):
    create_worker_tables(db_session)
    create_organize_detail_tables(db_session)
    db_session.execute(text("CREATE TABLE IF NOT EXISTS SystemSetting (`key` TEXT PRIMARY KEY, `value` TEXT, `createdAt` TEXT, `updatedAt` TEXT)"))
    ai = serve_ai_metadata_gateway()
    try:
        for key, value in {
            "metadata.ai.baseUrl": f"http://127.0.0.1:{ai.server_port}",
            "metadata.ai.apiKey": "test-key",
            "metadata.ai.model": "test-model",
        }.items():
            db_session.execute(
                text("INSERT INTO SystemSetting (`key`, `value`, `createdAt`, `updatedAt`) VALUES (:key, :value, 'now', 'now')"),
                {"key": key, "value": value},
            )
        db_session.execute(
            text(
                """INSERT INTO LibraryWork (
                    id, title, normalizedTitle, author, normalizedAuthor, workType, status, publicationStatus,
                    trackingStatus, tags, metadataQuality, organizeStatus, coverStatus, hidden, organized,
                    mergeKey, createdAt, updatedAt
                ) VALUES (
                    'work-ai', 'messy_file.epub', 'messyfileepub', '', '', 'EPUB', 'WANT', 'UNKNOWN',
                    'NOT_TRACKING', '[]', 0, 'REVIEWING', 'PENDING', 0, 0, 'epub:ai', 'now', 'now'
                )"""
            )
        )
        db_session.execute(
            text(
                """INSERT INTO LibraryEdition (
                    id, workId, origin, format, importStatus, sizeBytes, "primary", hidden, createdAt, updatedAt
                ) VALUES ('edition-ai', 'work-ai', 'MANUAL', 'EPUB', 'IMPORTED', 10, 1, 0, 'now', 'now')"""
            )
        )
        db_session.execute(
            text(
                """INSERT INTO LibraryFile (
                    id, editionId, path, kind, mimeType, sizeBytes, sortOrder, createdAt, updatedAt
                ) VALUES ('file-ai', 'edition-ai', '/library/messy_file.epub', 'EPUB', 'application/epub+zip', 10, 0, 'now', 'now')"""
            )
        )
        db_session.commit()
        _login(client, db_session)

        refreshed = client.post("/api/works/work-ai/metadata/refresh", json={"providers": ["ai"]})

        assert refreshed.status_code == 200
        payload = refreshed.json()["data"]
        assert payload["enabled"] is True
        assert payload["added"] == 2
        assert "已刷新，新增 2 条" in payload["message"]
        assert ai.requests[0]["path"] == "/chat/completions"
        assert ai.requests[0]["authorization"] == "Bearer test-key"
        assert ai.requests[0]["body"]["model"] == "test-model"
        assert ai.requests[0]["body"]["response_format"] == {"type": "json_object"}
        assert json.loads(ai.requests[0]["body"]["messages"][1]["content"])["title"] == "messy_file.epub"

        job_id = payload["jobId"]
        assert db_session.execute(text("SELECT summary FROM OrganizeJob WHERE id = :id"), {"id": job_id}).scalar() == "新增 2 条外部/AI 元数据建议"
        suggestions = db_session.execute(text("SELECT field, source, suggestedValue, confidence FROM MetadataSuggestion WHERE jobId = :job_id ORDER BY field"), {"job_id": job_id}).mappings().all()
        assert [dict(item) for item in suggestions] == [
            {"field": "tags", "source": "ai", "suggestedValue": '["space", "ai"]', "confidence": 0.7},
            {"field": "title", "source": "ai", "suggestedValue": "AI Clean Title", "confidence": 0.74},
        ]

        repeated = client.post(f"/api/organize/jobs/{job_id}/refresh", json={"providers": ["ai"]})
        assert repeated.status_code == 200
        assert repeated.json()["data"]["added"] == 0
        assert db_session.execute(text("SELECT COUNT(*) FROM MetadataSuggestion WHERE jobId = :job_id"), {"job_id": job_id}).scalar() == 2
    finally:
        ai.shutdown()


def test_work_metadata_refresh_runs_douban_api_external_provider(client, db_session):
    create_worker_tables(db_session)
    create_organize_detail_tables(db_session)
    db_session.execute(text("CREATE TABLE IF NOT EXISTS SystemSetting (`key` TEXT PRIMARY KEY, `value` TEXT, `createdAt` TEXT, `updatedAt` TEXT)"))
    douban = serve_douban_api_gateway()
    try:
        for key, value in {
            "metadata.douban.mode": "api",
            "metadata.douban.baseUrl": f"http://127.0.0.1:{douban.server_port}",
            "metadata.douban.apiKey": "douban-key",
        }.items():
            db_session.execute(
                text("INSERT INTO SystemSetting (`key`, `value`, `createdAt`, `updatedAt`) VALUES (:key, :value, 'now', 'now')"),
                {"key": key, "value": value},
            )
        db_session.execute(
            text(
                """INSERT INTO LibraryWork (
                    id, title, normalizedTitle, author, normalizedAuthor, workType, status, publicationStatus,
                    trackingStatus, tags, metadataQuality, organizeStatus, coverStatus, hidden, organized,
                    mergeKey, createdAt, updatedAt
                ) VALUES (
                    'work-douban', 'Local Messy Title', 'localmessytitle', '', '', 'EPUB', 'WANT', 'UNKNOWN',
                    'NOT_TRACKING', '[]', 0, 'REVIEWING', 'PENDING', 0, 0, 'epub:douban', 'now', 'now'
                )"""
            )
        )
        db_session.execute(
            text(
                """INSERT INTO LibraryEdition (
                    id, workId, origin, format, importStatus, identifier, isbn, sizeBytes, "primary", hidden, createdAt, updatedAt
                ) VALUES ('edition-douban', 'work-douban', 'MANUAL', 'EPUB', 'IMPORTED', NULL, '9787111111111', 10, 1, 0, 'now', 'now')"""
            )
        )
        db_session.commit()
        _login(client, db_session)

        refreshed = client.post("/api/works/work-douban/metadata/refresh", json={"providers": ["external"]})

        assert refreshed.status_code == 200
        payload = refreshed.json()["data"]
        assert payload["enabled"] is True
        assert payload["added"] == 5
        assert payload["results"][0]["provider"] == "douban"
        assert douban.requests[0]["path"] == "/v2/book/isbn/9787111111111?apikey=douban-key"
        assert douban.requests[0]["accept"] == "application/json"
        suggestions = db_session.execute(
            text("SELECT field, source, suggestedValue, confidence FROM MetadataSuggestion WHERE jobId = :job_id ORDER BY field"),
            {"job_id": payload["jobId"]},
        ).mappings().all()
        assert [dict(item) for item in suggestions] == [
            {"field": "author", "source": "douban", "suggestedValue": "External Author", "confidence": 0.92},
            {"field": "description", "source": "douban", "suggestedValue": "External description", "confidence": 0.82},
            {"field": "publishedYear", "source": "douban", "suggestedValue": "2024", "confidence": 0.82},
            {"field": "tags", "source": "douban", "suggestedValue": '["fiction", "space"]', "confidence": 0.76},
            {"field": "title", "source": "douban", "suggestedValue": "Douban Clean Title", "confidence": 0.92},
        ]
    finally:
        douban.shutdown()


def test_work_metadata_refresh_runs_douban_crawler_external_provider(client, db_session):
    create_worker_tables(db_session)
    create_organize_detail_tables(db_session)
    db_session.execute(text("CREATE TABLE IF NOT EXISTS SystemSetting (`key` TEXT PRIMARY KEY, `value` TEXT, `createdAt` TEXT, `updatedAt` TEXT)"))
    douban = serve_douban_crawler_gateway()
    try:
        for key, value in {
            "metadata.douban.mode": "crawler",
            "metadata.douban.baseUrl": f"http://127.0.0.1:{douban.server_port}",
            "metadata.douban.userAgent": "ShukuCrawlerTest/1.0",
        }.items():
            db_session.execute(
                text("INSERT INTO SystemSetting (`key`, `value`, `createdAt`, `updatedAt`) VALUES (:key, :value, 'now', 'now')"),
                {"key": key, "value": value},
            )
        db_session.execute(
            text(
                """INSERT INTO LibraryWork (
                    id, title, normalizedTitle, author, normalizedAuthor, workType, status, publicationStatus,
                    trackingStatus, tags, metadataQuality, organizeStatus, coverStatus, hidden, organized,
                    mergeKey, createdAt, updatedAt
                ) VALUES (
                    'work-douban-crawler', '活着', '活着', '余华', '余华', 'EPUB', 'WANT', 'UNKNOWN',
                    'NOT_TRACKING', '[]', 0, 'REVIEWING', 'PENDING', 0, 0, 'epub:douban-crawler', 'now', 'now'
                )"""
            )
        )
        db_session.execute(
            text(
                """INSERT INTO LibraryEdition (
                    id, workId, origin, format, importStatus, sizeBytes, "primary", hidden, createdAt, updatedAt
                ) VALUES ('edition-douban-crawler', 'work-douban-crawler', 'MANUAL', 'EPUB', 'IMPORTED', 10, 1, 0, 'now', 'now')"""
            )
        )
        db_session.commit()
        _login(client, db_session)

        refreshed = client.post("/api/works/work-douban-crawler/metadata/refresh", json={"providers": ["external"]})

        assert refreshed.status_code == 200
        payload = refreshed.json()["data"]
        assert payload["enabled"] is True
        assert payload["added"] == 4
        assert douban.requests[0]["path"].startswith("/subject_search?search_text=")
        assert douban.requests[0]["user_agent"] == "ShukuCrawlerTest/1.0"
        assert douban.requests[1]["path"] == "/subject/4913064/"
        suggestions = db_session.execute(
            text("SELECT field, source, suggestedValue, confidence FROM MetadataSuggestion WHERE jobId = :job_id ORDER BY field"),
            {"job_id": payload["jobId"]},
        ).mappings().all()
        assert [dict(item) for item in suggestions] == [
            {"field": "author", "source": "douban", "suggestedValue": "余华", "confidence": 0.8},
            {"field": "description", "source": "douban", "suggestedValue": "这是一本关于生命韧性的小说。", "confidence": 0.8},
            {"field": "publishedYear", "source": "douban", "suggestedValue": "2012", "confidence": 0.8},
            {"field": "title", "source": "douban", "suggestedValue": "活着", "confidence": 0.8},
        ]
    finally:
        douban.shutdown()


def test_ebook_metadata_search_returns_all_douban_crawler_candidates_and_proxy_cover(client, db_session):
    create_worker_tables(db_session)
    create_organize_detail_tables(db_session)
    db_session.execute(text("CREATE TABLE IF NOT EXISTS SystemSetting (`key` TEXT PRIMARY KEY, `value` TEXT, `createdAt` TEXT, `updatedAt` TEXT)"))
    douban = serve_douban_crawler_gateway()
    try:
        for key, value in {
            "metadata.douban.mode": "crawler",
            "metadata.douban.baseUrl": f"http://127.0.0.1:{douban.server_port}",
            "metadata.douban.userAgent": "ShukuCrawlerTest/1.0",
        }.items():
            db_session.execute(
                text("INSERT INTO SystemSetting (`key`, `value`, `createdAt`, `updatedAt`) VALUES (:key, :value, 'now', 'now')"),
                {"key": key, "value": value},
            )
        db_session.execute(
            text(
                """INSERT INTO LibraryWork (
                    id, title, normalizedTitle, author, normalizedAuthor, workType, status, publicationStatus,
                    trackingStatus, tags, metadataQuality, organizeStatus, coverStatus, hidden, organized,
                    mergeKey, createdAt, updatedAt
                ) VALUES (
                    'work-douban-search', '活着', '活着', '', '', 'EPUB', 'WANT', 'UNKNOWN',
                    'NOT_TRACKING', '[]', 0, 'REVIEWING', 'PENDING', 0, 0, 'epub:douban-search', 'now', 'now'
                )"""
            )
        )
        db_session.execute(
            text(
                """INSERT INTO LibraryEdition (
                    id, workId, origin, format, importStatus, sizeBytes, "primary", hidden, createdAt, updatedAt
                ) VALUES ('edition-douban-search', 'work-douban-search', 'MANUAL', 'EPUB', 'IMPORTED', 10, 1, 0, 'now', 'now')"""
            )
        )
        db_session.commit()
        _login(client, db_session)

        searched = client.post("/api/works/work-douban-search/metadata/search", json={"source": "douban", "query": "活着"})

        assert searched.status_code == 200
        search_payload = searched.json()["data"]
        assert [item["title"] for item in search_payload["candidates"]] == ["活着", "活着：新版"]
        assert search_payload["candidates"][0]["description"] == "这是一本关于生命韧性的小说。"
        assert search_payload["candidates"][0]["coverUrl"].startswith(f"http://127.0.0.1:{douban.server_port}/covers/")
        assert search_payload["candidates"][1]["coverUrl"].startswith(f"http://127.0.0.1:{douban.server_port}/covers/")

        proxied = client.get(f"/api/metadata/cover-proxy?url={quote(search_payload['candidates'][0]['coverUrl'], safe='')}")

        assert proxied.status_code == 200
        assert proxied.headers["content-type"] == "image/jpeg"
        assert proxied.content == b"\xff\xd8\xff\xd9"
    finally:
        douban.shutdown()


def test_auto_epub_metadata_applies_later_exact_douban_candidate_and_series(db_session):
    create_worker_tables(db_session)
    create_organize_detail_tables(db_session)
    gateway = serve_priority_metadata_gateway("douban-later-exact")
    try:
        insert_priority_metadata_fixture(db_session, gateway)

        applied = _auto_apply_epub_metadata(db_session, "work-priority", "edition-priority", "task-priority")

        assert applied is True
        work = db_session.execute(text("SELECT title, author, seriesName, organized, organizeStatus FROM LibraryWork WHERE id = 'work-priority'")).mappings().first()
        assert dict(work) == {
            "title": "黑暗坡食人树",
            "author": "[日]岛田庄司",
            "seriesName": "午夜文库·大师系列：岛田庄司作品·御手洗洁系列",
            "organized": 1,
            "organizeStatus": "APPLIED",
        }
        assert any(request["path"] == "/subject/1002/" for request in gateway.requests)
        assert not any(request["path"] == "/v0/search/subjects" for request in gateway.requests)
    finally:
        gateway.shutdown()


def test_auto_epub_metadata_falls_back_to_bangumi_when_douban_has_no_exact_title(db_session):
    create_worker_tables(db_session)
    create_organize_detail_tables(db_session)
    gateway = serve_priority_metadata_gateway("douban-no-exact")
    try:
        insert_priority_metadata_fixture(db_session, gateway)

        applied = _auto_apply_epub_metadata(db_session, "work-priority", "edition-priority", "task-priority")

        assert applied is True
        work = db_session.execute(text("SELECT title, author, organized, organizeStatus FROM LibraryWork WHERE id = 'work-priority'")).mappings().first()
        assert dict(work) == {"title": "黑暗坡食人树", "author": "岛田庄司", "organized": 1, "organizeStatus": "APPLIED"}
        assert any(request["path"] == "/subject_search" for request in gateway.requests)
        assert any(request["path"] == "/v0/search/subjects" for request in gateway.requests)
    finally:
        gateway.shutdown()


def test_auto_epub_metadata_uses_ai_title_for_odd_hash_before_external_match(db_session):
    create_worker_tables(db_session)
    create_organize_detail_tables(db_session)
    gateway = serve_priority_metadata_gateway("ai-title")
    try:
        insert_priority_metadata_fixture(db_session, gateway, title="3b83c5f4795dda74d6e58e3b5748f5f3585275bb27580b9e9975481bc5ddd6ec")

        applied = _auto_apply_epub_metadata(db_session, "work-priority", "edition-priority", "task-priority")

        assert applied is True
        paths = [request["path"] for request in gateway.requests]
        assert paths.index("/chat/completions") < paths.index("/subject_search")
        search_request = next(request for request in gateway.requests if request["path"] == "/subject_search")
        assert search_request["query"]["search_text"] == ["黑暗坡食人树"]
        work = db_session.execute(text("SELECT title, seriesName, organized FROM LibraryWork WHERE id = 'work-priority'")).mappings().first()
        assert dict(work) == {"title": "黑暗坡食人树", "seriesName": "午夜文库·大师系列：岛田庄司作品·御手洗洁系列", "organized": 1}
    finally:
        gateway.shutdown()


def test_auto_epub_metadata_keeps_reviewing_when_no_provider_has_exact_title(db_session):
    create_worker_tables(db_session)
    create_organize_detail_tables(db_session)
    gateway = serve_priority_metadata_gateway("no-exact")
    try:
        insert_priority_metadata_fixture(db_session, gateway)

        applied = _auto_apply_epub_metadata(db_session, "work-priority", "edition-priority", "task-priority")

        assert applied is False
        work = db_session.execute(text("SELECT title, organized, organizeStatus FROM LibraryWork WHERE id = 'work-priority'")).mappings().first()
        assert dict(work) == {"title": "黑暗坡食人树", "organized": 0, "organizeStatus": "REVIEWING"}
        assert db_session.execute(text("SELECT COUNT(*) FROM MetadataSuggestion WHERE jobId = 'job-priority' AND source IN ('douban', 'bangumi')")).scalar() == 0
    finally:
        gateway.shutdown()


def test_work_metadata_refresh_runs_bangumi_external_provider(client, db_session):
    create_worker_tables(db_session)
    create_organize_detail_tables(db_session)
    db_session.execute(text("CREATE TABLE IF NOT EXISTS SystemSetting (`key` TEXT PRIMARY KEY, `value` TEXT, `createdAt` TEXT, `updatedAt` TEXT)"))
    bangumi = serve_bangumi_api_gateway()
    try:
        for key, value in {
            "metadata.bangumi.baseUrl": f"http://127.0.0.1:{bangumi.server_port}",
            "metadata.bangumi.accessToken": "bangumi-token",
            "metadata.bangumi.userAgent": "ShukuTest/1.0",
        }.items():
            db_session.execute(
                text("INSERT INTO SystemSetting (`key`, `value`, `createdAt`, `updatedAt`) VALUES (:key, :value, 'now', 'now')"),
                {"key": key, "value": value},
            )
        db_session.execute(
            text(
                """INSERT INTO LibraryWork (
                    id, title, normalizedTitle, author, normalizedAuthor, workType, status, publicationStatus,
                    trackingStatus, tags, metadataQuality, organizeStatus, coverStatus, hidden, organized,
                    mergeKey, createdAt, updatedAt
                ) VALUES (
                    'work-bangumi', 'Star Comic Vol.1', 'starcomicvol1', '', '', 'COMIC', 'WANT', 'UNKNOWN',
                    'NOT_TRACKING', '[]', 0, 'REVIEWING', 'PENDING', 0, 0, 'comic:bangumi', 'now', 'now'
                )"""
            )
        )
        db_session.execute(
            text(
                """INSERT INTO LibraryEdition (
                    id, workId, origin, format, importStatus, sizeBytes, "primary", hidden, createdAt, updatedAt
                ) VALUES ('edition-bangumi', 'work-bangumi', 'MANUAL', 'CBZ', 'IMPORTED', 10, 1, 0, 'now', 'now')"""
            )
        )
        db_session.commit()
        _login(client, db_session)

        refreshed = client.post("/api/works/work-bangumi/metadata/refresh", json={"providers": ["external"]})

        assert refreshed.status_code == 200
        payload = refreshed.json()["data"]
        assert payload["enabled"] is True
        assert payload["added"] == 6
        assert bangumi.requests[0]["path"] == "/v0/search/subjects"
        assert bangumi.requests[0]["authorization"] == "Bearer bangumi-token"
        assert bangumi.requests[0]["user_agent"] == "ShukuTest/1.0"
        assert bangumi.requests[0]["body"] == {"keyword": "Star Comic Vol.1", "sort": "match", "filter": {"type": [1]}}
        suggestions = db_session.execute(
            text("SELECT field, source, suggestedValue, confidence FROM MetadataSuggestion WHERE jobId = :job_id ORDER BY field"),
            {"job_id": payload["jobId"]},
        ).mappings().all()
        assert [dict(item) for item in suggestions] == [
            {"field": "author", "source": "bangumi", "suggestedValue": "漫画作者", "confidence": 0.78},
            {"field": "description", "source": "bangumi", "suggestedValue": "Bangumi description", "confidence": 0.8},
            {"field": "publishedYear", "source": "bangumi", "suggestedValue": "2022", "confidence": 0.78},
            {"field": "seriesName", "source": "bangumi", "suggestedValue": "星舰漫画", "confidence": 0.82},
            {"field": "tags", "source": "bangumi", "suggestedValue": '["科幻", "漫画"]', "confidence": 0.72},
            {"field": "title", "source": "bangumi", "suggestedValue": "星舰漫画", "confidence": 0.82},
        ]
    finally:
        bangumi.shutdown()


def test_ebook_metadata_search_apply_and_refresh_can_use_bangumi(client, db_session):
    create_worker_tables(db_session)
    create_organize_detail_tables(db_session)
    db_session.execute(text("CREATE TABLE IF NOT EXISTS SystemSetting (`key` TEXT PRIMARY KEY, `value` TEXT, `createdAt` TEXT, `updatedAt` TEXT)"))
    bangumi = serve_bangumi_api_gateway()
    try:
        for key, value in {
            "metadata.bangumi.baseUrl": f"http://127.0.0.1:{bangumi.server_port}",
            "metadata.bangumi.userAgent": "ShukuEbookTest/1.0",
        }.items():
            db_session.execute(
                text("INSERT INTO SystemSetting (`key`, `value`, `createdAt`, `updatedAt`) VALUES (:key, :value, 'now', 'now')"),
                {"key": key, "value": value},
            )
        db_session.execute(
            text(
                """INSERT INTO LibraryWork (
                    id, title, normalizedTitle, author, normalizedAuthor, workType, status, publicationStatus,
                    trackingStatus, tags, metadataQuality, organizeStatus, coverStatus, hidden, organized,
                    mergeKey, createdAt, updatedAt
                ) VALUES (
                    'work-ebook-bangumi', 'Messy Ebook', 'messyebook', '', '', 'EPUB', 'WANT', 'UNKNOWN',
                    'NOT_TRACKING', '[]', 0, 'REVIEWING', 'PENDING', 0, 0, 'epub:bangumi', 'now', 'now'
                )"""
            )
        )
        db_session.execute(
            text(
                """INSERT INTO LibraryEdition (
                    id, workId, origin, format, importStatus, sizeBytes, "primary", hidden, createdAt, updatedAt
                ) VALUES ('edition-ebook-bangumi', 'work-ebook-bangumi', 'MANUAL', 'EPUB', 'IMPORTED', 10, 1, 0, 'now', 'now')"""
            )
        )
        db_session.commit()
        _login(client, db_session)

        searched = client.post("/api/works/work-ebook-bangumi/metadata/search", json={"source": "bangumi", "query": "星舰"})

        assert searched.status_code == 200
        search_payload = searched.json()["data"]
        assert search_payload["candidates"][0]["source"] == "bangumi"
        assert search_payload["candidates"][0]["title"] == "星舰漫画"
        assert bangumi.requests[0]["body"] == {"keyword": "星舰", "sort": "match", "filter": {"type": [1]}}

        applied = client.post(
            "/api/works/work-ebook-bangumi/metadata/apply",
            json={"source": "bangumi", "candidate": search_payload["candidates"][0], "fields": ["title", "author", "description", "tags"]},
        )

        assert applied.status_code == 200
        applied_book = applied.json()["data"]["book"]
        assert applied_book["title"] == "星舰漫画"
        assert applied_book["author"] == "漫画作者"
        assert applied_book["tags"] == ["漫画", "科幻"]
        assert applied.json()["data"]["finishedOrganizeJobIds"]
        work_state = db_session.execute(text("SELECT organized, organizeStatus FROM LibraryWork WHERE id = 'work-ebook-bangumi'")).mappings().first()
        assert dict(work_state) == {"organized": 1, "organizeStatus": "APPLIED"}
        assert db_session.execute(text("SELECT COUNT(*) FROM OrganizeJob WHERE workId = 'work-ebook-bangumi' AND status IN ('PENDING', 'REVIEWING', 'FAILED')")).scalar() == 0
        pending = client.get("/api/organize/jobs?pageSize=100")
        assert all(job["book"]["id"] != "work-ebook-bangumi" for job in pending.json()["data"]["jobs"])

        refreshed = client.post("/api/works/work-ebook-bangumi/metadata/refresh", json={"providers": ["bangumi"]})

        assert refreshed.status_code == 200
        refresh_payload = refreshed.json()["data"]
        assert refresh_payload["enabled"] is True
        assert refresh_payload["added"] == 6
        assert bangumi.requests[-1]["body"] == {"keyword": "星舰漫画", "sort": "match", "filter": {"type": [1]}}
        work_state = db_session.execute(text("SELECT organized, organizeStatus FROM LibraryWork WHERE id = 'work-ebook-bangumi'")).mappings().first()
        assert dict(work_state) == {"organized": 1, "organizeStatus": "APPLIED"}
        assert db_session.execute(text("SELECT COUNT(*) FROM OrganizeJob WHERE workId = 'work-ebook-bangumi' AND status IN ('PENDING', 'REVIEWING', 'FAILED')")).scalar() == 0
        sources = db_session.execute(text("SELECT DISTINCT source FROM MetadataSuggestion")).scalars().all()
        assert sources == ["bangumi"]
    finally:
        bangumi.shutdown()


def test_backup_create_download_and_restore_database_export(client, db_session, test_settings):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    _login(client, db_session)
    stored_file = test_settings.resolved_storage_root / "books" / "backup-work" / "edition-1" / "book.epub"
    stored_file.parent.mkdir(parents=True)
    stored_file.write_bytes(b"backup-file-content")
    db_session.execute(
        text(
            """INSERT INTO LibraryWork (
                id, title, normalizedTitle, author, normalizedAuthor, workType, status, publicationStatus,
                trackingStatus, tags, metadataQuality, organizeStatus, coverStatus, hidden, organized,
                mergeKey, createdAt, updatedAt
            ) VALUES (
                'backup-work', 'Backup Book', 'backupbook', 'Author', 'author', 'EPUB', 'WANT', 'UNKNOWN',
                'NOT_TRACKING', '[]', 80, 'APPLIED', 'PENDING', 0, 1, 'epub:backup:author', 'now', 'now'
            )"""
        )
    )
    db_session.execute(
        text(
            """INSERT INTO LibraryEdition (
                id, workId, origin, format, versionName, importStatus, sizeBytes, chapterCount,
                coverStatus, "primary", hidden, createdAt, updatedAt
            ) VALUES (
                'backup-edition', 'backup-work', 'MANUAL', 'EPUB', 'EPUB 1', 'COMPLETED', 19, 1,
                'PENDING', 1, 0, 'now', 'now'
            )"""
        )
    )
    db_session.execute(
        text(
            """INSERT INTO LibraryVolume (
                id, editionId, title, sortOrder, chapterCount, createdAt, updatedAt
            ) VALUES (
                'backup-volume', 'backup-edition', '正文', 0, 1, 'now', 'now'
            )"""
        )
    )
    db_session.execute(
        text(
            """INSERT INTO LibraryFile (
                id, editionId, volumeId, path, filePathHash, hashStatus, mtimeMs, kind, mimeType,
                sizeBytes, sortOrder, createdAt, updatedAt
            ) VALUES (
                'backup-file', 'backup-edition', 'backup-volume', :path, 'hash', 'PARTIAL_PENDING',
                1, 'EPUB', 'application/epub+zip', 19, 0, 'now', 'now'
            )"""
        ),
        {"path": str(stored_file)},
    )
    db_session.execute(
        text("INSERT INTO SystemSetting (`key`, `value`, `createdAt`, `updatedAt`) VALUES ('backup.scope', :value, 'now', 'now')"),
        {"value": json.dumps({"mode": "manual"})},
    )
    db_session.commit()

    created = client.post("/api/backups")

    assert created.status_code == 201
    backup = created.json()["data"]["backup"]
    assert backup["counts"]["works"] == 1
    assert backup["counts"]["systemSettings"] == 1
    assert backup["counts"]["libraryFiles"] == 0
    backup_path = test_settings.resolved_storage_root / "backups" / backup["filename"]
    with zipfile.ZipFile(backup_path) as archive:
        names = set(archive.namelist())
        assert set(["metadata.json", "database-export.json", "settings.json"]).issubset(names)
        assert "library-files.json" not in names
        assert all(not name.startswith("library-files/") for name in names)
        metadata = json.loads(archive.read("metadata.json").decode("utf-8"))
        database_export = json.loads(archive.read("database-export.json").decode("utf-8"))
        settings_export = json.loads(archive.read("settings.json").decode("utf-8"))
        assert metadata["kind"] == "manual"
        assert metadata["counts"]["libraryFiles"] == 0
        assert "reader-content-files" in metadata["excludes"]
        assert database_export["systemSettings"][0]["key"] == "backup.scope"
        assert settings_export["backupMode"] == "manual"

    downloaded = client.get(f"/api/backups/{backup['id']}/download", headers={"Range": "bytes=0-3"})
    assert downloaded.status_code == 206
    assert downloaded.content == b"PK\x03\x04"

    stored_file.unlink()
    db_session.execute(text("DELETE FROM LibraryWork WHERE id = 'backup-work'"))
    db_session.commit()
    assert db_session.execute(text("SELECT COUNT(*) FROM LibraryWork WHERE id = 'backup-work'")).scalar() == 0
    assert not stored_file.exists()

    restored = client.post(f"/api/backups/{backup['id']}/restore")

    assert restored.status_code == 200
    assert restored.json()["data"]["restored"] is True
    assert restored.json()["data"]["restoredCounts"]["works"] == 1
    assert restored.json()["data"]["restoredCounts"]["systemSettings"] == 1
    assert restored.json()["data"]["restoredCounts"]["libraryFiles"] == 0
    assert restored.json()["data"]["actualCounts"]["works"] == 1
    db_session.commit()
    restored_rows = db_session.execute(text("SELECT id, title FROM LibraryWork")).mappings().all()
    assert restored_rows
    assert db_session.execute(text("SELECT title FROM LibraryWork WHERE id = 'backup-work'")).scalar() == "Backup Book"
    assert db_session.execute(text("SELECT `value` FROM SystemSetting WHERE `key` = 'backup.scope'")).scalar() == json.dumps({"mode": "manual"})
    assert not stored_file.exists()


def test_backup_listing_keeps_legacy_automatic_files_manual_only(client, db_session, test_settings):
    from app.services.backup_service import list_backups

    test_settings.resolved_storage_root.mkdir(parents=True)
    _login(client, db_session)
    backup_root = test_settings.resolved_storage_root / "backups"
    backup_root.mkdir(parents=True)
    manual_id = "manual-20260612-030000-keepme"
    automatic_id = "automatic-20260612-030000-legacy"
    with zipfile.ZipFile(backup_root / f"{manual_id}.zip", "w") as archive:
        archive.writestr("metadata.json", json.dumps({"id": manual_id, "kind": "manual", "app": "shuku-starship", "version": 2, "createdAt": "2026-06-12T03:00:00+00:00", "counts": {}}))
    with zipfile.ZipFile(backup_root / f"{automatic_id}.zip", "w") as archive:
        archive.writestr("metadata.json", json.dumps({"id": automatic_id, "kind": "automatic", "app": "shuku-starship", "version": 2, "createdAt": "2026-06-11T03:00:00+00:00", "counts": {}}))

    backups = list_backups(test_settings)
    assert {backup["id"] for backup in backups} == {manual_id, automatic_id}

    deleted = client.delete(f"/api/backups/{automatic_id}")
    assert deleted.status_code == 200
    assert deleted.json()["data"]["deleted"] is True
    assert not (backup_root / f"{automatic_id}.zip").exists()


def test_manual_epub_upload_imports_book(client, db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    _login(client, db_session)
    epub = tmp_path / "manual.epub"
    write_epub_fixture(epub)

    with epub.open("rb") as handle:
        response = client.post("/api/works/import", files={"file": ("manual.epub", handle, "application/epub+zip")})

    assert response.status_code == 200
    payload = response.json()["data"]
    assert payload["imported"] == 1
    assert payload["results"][0]["type"] == "ebook"
    assert payload["tasks"][0]["status"] == "COMPLETED"

    works = client.get("/api/works")
    assert works.status_code == 200
    assert works.json()["data"]["total"] == 1

    edition_id = payload["results"][0]["editionId"]
    partial = client.get(f"/api/editions/{edition_id}/file", headers={"Range": "bytes=0-3"})
    assert partial.status_code == 206
    assert partial.headers["accept-ranges"] == "bytes"
    assert partial.headers["content-range"].startswith("bytes 0-3/")
    assert partial.content == epub.read_bytes()[:4]

    cached = client.get(f"/api/editions/{edition_id}/file", headers={"If-None-Match": partial.headers["etag"]})
    assert cached.status_code == 304

    invalid = client.get(f"/api/editions/{edition_id}/file", headers={"Range": "bytes=999999-1000000"})
    assert invalid.status_code == 416
    assert invalid.headers["content-range"].startswith("bytes */")


def test_reader_bootstrap_matches_node_shapes_for_epub_and_comic(client, db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    _login(client, db_session)
    epub = tmp_path / "manual.epub"
    comic = tmp_path / "comic.zip"
    write_epub_fixture(epub)
    write_comic_fixture(comic)

    with epub.open("rb") as handle:
        epub_imported = client.post("/api/works/import", files={"file": ("manual.epub", handle, "application/epub+zip")})
    with comic.open("rb") as handle:
        comic_imported = client.post("/api/works/import", files={"file": ("comic.zip", handle, "application/zip")})

    epub_payload = epub_imported.json()["data"]["results"][0]
    epub_bootstrap = client.get(f"/api/reader/{epub_payload['editionId']}/bootstrap")
    assert epub_bootstrap.status_code == 200
    epub_data = epub_bootstrap.json()["data"]
    assert epub_data["readerType"] == "ebook"
    assert epub_data["book"]["editionId"] == epub_payload["editionId"]
    assert epub_data["book"]["formatValue"] == "EPUB"
    assert epub_data["totalUnits"] == 2
    assert [unit["title"] for unit in epub_data["readingUnits"]] == ["第一节", "第二节"]
    assert isinstance(epub_data["readingUnits"][0]["metadataJson"], dict)
    epub_detail = client.get(f"/api/works/{epub_payload['workId']}")
    assert epub_detail.status_code == 200
    epub_detail_data = epub_detail.json()["data"]
    assert epub_detail_data["book"]["editionId"] == epub_payload["editionId"]
    assert [unit["title"] for unit in epub_detail_data["readingUnits"]] == ["第一节", "第二节"]
    assert epub_detail_data["comicSections"] == []

    comic_payload = comic_imported.json()["data"]["results"][0]
    comic_bootstrap = client.get(f"/api/reader/{comic_payload['editionId']}/bootstrap")
    assert comic_bootstrap.status_code == 200
    comic_data = comic_bootstrap.json()["data"]
    assert comic_data["readerType"] == "comic"
    assert comic_data["book"]["editionId"] == comic_payload["editionId"]
    assert comic_data["book"]["formatValue"] == "COMIC"
    assert comic_data["section"]["id"] == comic_payload["volumeId"]
    assert comic_data["sections"] == [{"id": comic_payload["volumeId"], "title": "第 1 卷", "pageCount": 2}]
    assert comic_data["pageCount"] == 2
    assert [page["pageIndex"] for page in comic_data["pages"]] == [1, 2]
    comic_detail = client.get(f"/api/works/{comic_payload['workId']}")
    assert comic_detail.status_code == 200
    comic_detail_data = comic_detail.json()["data"]
    assert comic_detail_data["book"]["editionId"] == comic_payload["editionId"]
    assert comic_detail_data["readingUnits"] == []
    assert comic_detail_data["comicSections"] == [{"id": comic_payload["volumeId"], "title": "第 1 卷", "index": 1, "fileId": comic_payload["volumeId"], "pageCount": 2, "coverUrl": f"/api/volumes/{comic_payload['volumeId']}/cover?editionId={comic_payload['editionId']}"}]

    db_session.execute(
        text(
            """
            INSERT INTO LibraryEdition (
                id, workId, monitorFolderId, origin, format, versionName, versionKey, sourceGroupKey,
                description, language, publisher, publishedAt, identifier, isbn, importStatus, importError,
                sizeBytes, pageCount, chapterCount, coverPath, coverStatus, "primary", hidden, createdAt, updatedAt
            ) VALUES (
                'comic-edition-alt', :work_id, NULL, 'MANUAL', 'COMIC', '备用版本', 'alt', NULL,
                NULL, NULL, NULL, NULL, NULL, NULL, 'COMPLETED', NULL,
                0, 5, NULL, NULL, 'PENDING', 0, 0, 'now', 'now'
            )
            """
        ),
        {"work_id": comic_payload["workId"]},
    )
    db_session.execute(
        text(
            """
            INSERT INTO LibraryVolume (
                id, editionId, title, volumeIndex, sortOrder, pageCount, chapterCount, coverPath, createdAt, updatedAt
            ) VALUES
                ('comic-alt-volume-1', 'comic-edition-alt', '第 1 话', 1, 0, 2, NULL, NULL, 'now', 'now'),
                ('comic-alt-volume-2', 'comic-edition-alt', '第 2 话', 2, 1, 3, NULL, NULL, 'now', 'now')
            """
        )
    )
    db_session.execute(
        text(
            """
            INSERT INTO LibraryReadingUnit (
                id, editionId, volumeId, fileId, unitType, title, href, mediaType, sortOrder,
                width, height, size, metadataJson, createdAt, updatedAt
            ) VALUES
                ('comic-alt-page-1', 'comic-edition-alt', 'comic-alt-volume-1', NULL, 'page', '001.jpg', '001.jpg', 'image/jpeg', 0, NULL, NULL, NULL, '{}', 'now', 'now'),
                ('comic-alt-page-2', 'comic-edition-alt', 'comic-alt-volume-1', NULL, 'page', '002.jpg', '002.jpg', 'image/jpeg', 1, NULL, NULL, NULL, '{}', 'now', 'now'),
                ('comic-alt-page-3', 'comic-edition-alt', 'comic-alt-volume-2', NULL, 'page', '001.jpg', '001.jpg', 'image/jpeg', 0, NULL, NULL, NULL, '{}', 'now', 'now'),
                ('comic-alt-page-4', 'comic-edition-alt', 'comic-alt-volume-2', NULL, 'page', '002.jpg', '002.jpg', 'image/jpeg', 1, NULL, NULL, NULL, '{}', 'now', 'now'),
                ('comic-alt-page-5', 'comic-edition-alt', 'comic-alt-volume-2', NULL, 'page', '003.jpg', '003.jpg', 'image/jpeg', 2, NULL, NULL, NULL, '{}', 'now', 'now')
            """
        )
    )
    db_session.commit()

    multi_detail = client.get(f"/api/works/{comic_payload['workId']}")
    assert multi_detail.status_code == 200
    multi_book = multi_detail.json()["data"]["book"]
    assert multi_book["versionCount"] == 2
    assert [edition["versionName"] for edition in multi_book["editions"]] == ["漫画版本", "备用版本"]
    assert [volume["title"] for volume in multi_book["editions"][1]["volumes"]] == ["第 1 话", "第 2 话"]

    alt_bootstrap = client.get("/api/reader/comic-edition-alt/bootstrap?volume=comic-alt-volume-2")
    assert alt_bootstrap.status_code == 200
    alt_data = alt_bootstrap.json()["data"]
    assert alt_data["readerType"] == "comic"
    assert alt_data["book"]["editionId"] == "comic-edition-alt"
    assert alt_data["section"] == {"id": "comic-alt-volume-2", "title": "第 2 话", "pageCount": 3}
    assert alt_data["sections"] == [
        {"id": "comic-alt-volume-1", "title": "第 1 话", "pageCount": 2},
        {"id": "comic-alt-volume-2", "title": "第 2 话", "pageCount": 3},
    ]
    assert [page["pageIndex"] for page in alt_data["pages"]] == [1, 2, 3]


def test_file_streams_are_limited_per_user(client, db_session, test_settings, tmp_path, monkeypatch):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    _login(client, db_session)
    epub = tmp_path / "manual.epub"
    write_epub_fixture(epub)

    with epub.open("rb") as handle:
        response = client.post("/api/works/import", files={"file": ("manual.epub", handle, "application/epub+zip")})

    assert response.status_code == 200
    edition_id = response.json()["data"]["results"][0]["editionId"]
    user_id = db_session.execute(text("SELECT id FROM User WHERE email = 'admin@example.com'")).scalar()
    monkeypatch.setattr(compat, "STREAMS_PER_USER_LIMIT", 1)
    with compat._active_file_streams_lock:
        compat._active_file_streams_by_user[user_id] = 1
    try:
        limited = client.get(f"/api/editions/{edition_id}/file")
        assert limited.status_code == 429
        assert limited.json()["error"]["message"] == "同时文件流请求过多，请稍后重试"
    finally:
        with compat._active_file_streams_lock:
            compat._active_file_streams_by_user.pop(user_id, None)


def test_file_streams_log_slow_requests(client, db_session, test_settings, tmp_path, monkeypatch, caplog):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    _login(client, db_session)
    epub = tmp_path / "manual.epub"
    write_epub_fixture(epub)

    with epub.open("rb") as handle:
        response = client.post("/api/works/import", files={"file": ("manual.epub", handle, "application/epub+zip")})

    assert response.status_code == 200
    edition_id = response.json()["data"]["results"][0]["editionId"]
    monkeypatch.setattr(compat, "SLOW_REQUEST_LOG_THRESHOLD_MS", 0)
    with caplog.at_level("WARNING", logger="app.api.routes.compat"):
        streamed = client.get(f"/api/editions/{edition_id}/file", headers={"Range": "bytes=0-3"})

    assert streamed.status_code == 206
    assert any("[slow-file-request]" in record.message and "route=edition-file" in record.message for record in caplog.records)


def test_manual_pdf_upload_imports_book(client, db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    _login(client, db_session)
    pdf = tmp_path / "manual.pdf"
    write_pdf_fixture(pdf)

    with pdf.open("rb") as handle:
        response = client.post("/api/works/import", files={"file": ("manual.pdf", handle, "application/pdf")})

    assert response.status_code == 200
    payload = response.json()["data"]
    assert payload["imported"] == 1
    assert payload["results"][0]["format"] == "pdf"
    edition_id = payload["results"][0]["editionId"]

    file_response = client.get(f"/api/editions/{edition_id}/file", headers={"Range": "bytes=0-4"})
    assert file_response.status_code == 206
    assert file_response.headers["content-type"].startswith("application/pdf")
    assert file_response.content == b"%PDF-"


def test_manual_comic_upload_serves_archive_page(client, db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    _login(client, db_session)
    comic = tmp_path / "comic.zip"
    write_comic_fixture(comic)

    with comic.open("rb") as handle:
        imported = client.post("/api/works/import", files={"file": ("comic.zip", handle, "application/zip")})

    assert imported.status_code == 200
    volume_id = imported.json()["data"]["results"][0]["volumeId"]
    assert db_session.execute(text("SELECT COUNT(*) FROM LibraryReadingUnit WHERE volumeId = :volume_id"), {"volume_id": volume_id}).scalar() == 0
    page = client.get(f"/api/volumes/{volume_id}/pages/1")

    assert page.status_code == 200
    assert page.content == b"one"
    assert page.headers["content-type"].startswith("image/jpeg")
    assert db_session.execute(text("SELECT COUNT(*) FROM LibraryReadingUnit WHERE volumeId = :volume_id"), {"volume_id": volume_id}).scalar() == 2

    ranged = client.get(f"/api/volumes/{volume_id}/pages/1", headers={"Range": "bytes=1-2"})
    assert ranged.status_code == 206
    assert ranged.content == b"ne"
    assert ranged.headers["content-range"] == "bytes 1-2/3"

    cached = client.get(f"/api/volumes/{volume_id}/pages/1", headers={"If-None-Match": page.headers["etag"]})
    assert cached.status_code == 304


def test_volume_pages_rebuilds_missing_comic_page_index(client, db_session, test_settings, tmp_path):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    _login(client, db_session)
    comic = tmp_path / "comic.zip"
    write_comic_fixture(comic)

    with comic.open("rb") as handle:
        imported = client.post("/api/works/import", files={"file": ("comic.zip", handle, "application/zip")})

    assert imported.status_code == 200
    volume_id = imported.json()["data"]["results"][0]["volumeId"]
    db_session.execute(text("UPDATE LibraryVolume SET pageCount = NULL WHERE id = :volume_id"), {"volume_id": volume_id})
    db_session.commit()

    listed = client.get(f"/api/volumes/{volume_id}/pages")
    assert listed.status_code == 200
    pages = listed.json()["data"]["pages"]
    assert [page["href"] for page in pages] == ["001.jpg", "002.jpg"]
    assert db_session.execute(text("SELECT COUNT(*) FROM LibraryReadingUnit WHERE volumeId = :volume_id"), {"volume_id": volume_id}).scalar() == 2
    assert db_session.execute(text("SELECT pageCount FROM LibraryVolume WHERE id = :volume_id"), {"volume_id": volume_id}).scalar() == 2

    page = client.get(f"/api/volumes/{volume_id}/pages/2")
    assert page.status_code == 200
    assert page.content == b"two"


def test_archive_page_streams_are_limited_and_logged(client, db_session, test_settings, tmp_path, monkeypatch, caplog):
    create_worker_tables(db_session)
    test_settings.resolved_storage_root.mkdir(parents=True)
    _login(client, db_session)
    comic = tmp_path / "comic.zip"
    write_comic_fixture(comic)

    with comic.open("rb") as handle:
        imported = client.post("/api/works/import", files={"file": ("comic.zip", handle, "application/zip")})

    assert imported.status_code == 200
    volume_id = imported.json()["data"]["results"][0]["volumeId"]
    user_id = db_session.execute(text("SELECT id FROM User WHERE email = 'admin@example.com'")).scalar()
    monkeypatch.setattr(compat, "STREAMS_PER_USER_LIMIT", 1)
    with compat._active_file_streams_lock:
        compat._active_file_streams_by_user[user_id] = 1
    try:
        limited = client.get(f"/api/volumes/{volume_id}/pages/1")
        assert limited.status_code == 429
    finally:
        with compat._active_file_streams_lock:
            compat._active_file_streams_by_user.pop(user_id, None)

    monkeypatch.setattr(compat, "SLOW_REQUEST_LOG_THRESHOLD_MS", 0)
    with caplog.at_level("WARNING", logger="app.api.routes.compat"):
        streamed = client.get(f"/api/volumes/{volume_id}/pages/1", headers={"Range": "bytes=0-1"})

    assert streamed.status_code == 206
    assert streamed.content == b"on"
    assert any("[slow-file-request]" in record.message and "route=volume-page-zip" in record.message for record in caplog.records)
