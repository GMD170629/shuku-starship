from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
from collections.abc import Iterable
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker


REPO_ROOT = Path(__file__).resolve().parents[1]
API_ROOT = REPO_ROOT / "apps" / "api-python"
sys.path.insert(0, str(API_ROOT))

from app.core.auth import hash_password  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.models import auth, settings  # noqa: F401,E402
from app.models.auth import User  # noqa: E402
from tests.test_worker_importer import create_worker_tables, write_comic_fixture, write_epub_fixture, write_pdf_fixture  # noqa: E402

SUPPORTED_EXTS = {".epub", ".pdf", ".cbz", ".zip"}
MEDIA_TYPES = {
    ".epub": "application/epub+zip",
    ".pdf": "application/pdf",
    ".cbz": "application/vnd.comicbook+zip",
    ".zip": "application/zip",
}


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_health(base_url: str, process: subprocess.Popen[str]) -> None:
    deadline = time.time() + 20
    last_error: Exception | None = None
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"uvicorn exited early with code {process.returncode}")
        try:
            response = httpx.get(f"{base_url}/api/health", timeout=2)
            payload = response.json()
            if response.status_code == 200 and payload.get("ok") is True and payload.get("data", {}).get("status") == "ok":
                return
            last_error = RuntimeError(f"unexpected health response {response.status_code}: {payload}")
        except Exception as exc:  # noqa: BLE001
            last_error = exc
        time.sleep(0.25)
    raise RuntimeError(f"health check timed out: {last_error}")


def setup_database(database_url: str) -> None:
    engine = create_engine(database_url)
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    with SessionLocal() as db:
        create_worker_tables(db)
        db.add(User(email="admin@example.com", name="管理员", password_hash=hash_password("starshipnas"), role="admin"))
        db.commit()
    engine.dispose()


def expect_ok(response: httpx.Response) -> dict:
    try:
        payload = response.json()
    except ValueError as exc:
        raise AssertionError(f"response was not JSON: {response.status_code} {response.text[:200]}") from exc
    assert response.status_code == 200, payload
    assert payload.get("ok") is True, payload
    return payload["data"]


def upload_sample(client: httpx.Client, path: Path, media_type: str) -> dict:
    with path.open("rb") as handle:
        response = client.post("/api/works/import", files={"file": (path.name, handle, media_type)}, timeout=30)
    data = expect_ok(response)
    assert data["imported"] == 1, data
    assert data["results"], data
    return data["results"][0]


def validate_imported_sample(client: httpx.Client, result: dict, expected_ext: str) -> None:
    fmt = result["format"]
    if fmt == "epub":
        bootstrap = expect_ok(client.get(f"/api/reader/{result['editionId']}/bootstrap"))
        assert bootstrap["readerType"] == "ebook"
        assert bootstrap["book"]["editionId"] == result["editionId"]
        assert bootstrap["readingUnits"], bootstrap
        epub_file = client.get(f"/api/editions/{result['editionId']}/file", headers={"Range": "bytes=0-3"})
        assert epub_file.status_code == 206, epub_file.text
        assert epub_file.content == b"PK\x03\x04"
        return
    if fmt == "pdf":
        pdf_file = client.get(f"/api/editions/{result['editionId']}/file", headers={"Range": "bytes=0-4"})
        assert pdf_file.status_code == 206, pdf_file.text
        assert pdf_file.content == b"%PDF-"
        return
    if fmt in {"cbz", "zip"} or result["type"] == "comic":
        bootstrap = expect_ok(client.get(f"/api/reader/{result['editionId']}/bootstrap"))
        assert bootstrap["readerType"] == "comic"
        assert bootstrap["pages"], bootstrap
        pages = expect_ok(client.get(f"/api/volumes/{result['volumeId']}/pages"))
        assert pages["total"] >= 1, pages
        page = client.get(f"/api/volumes/{result['volumeId']}/pages/1")
        assert page.status_code == 200, page.text
        assert page.headers["content-type"].startswith("image/"), page.headers
        assert page.content, "comic page response was empty"
        return
    raise AssertionError(f"unsupported imported format {fmt!r} for {expected_ext}")


def run_http_flow(base_url: str, sample_dir: Path) -> None:
    epub = sample_dir / "sample.epub"
    comic = sample_dir / "sample.zip"
    pdf = sample_dir / "sample.pdf"
    write_epub_fixture(epub)
    write_comic_fixture(comic)
    write_pdf_fixture(pdf)

    with httpx.Client(base_url=base_url, follow_redirects=False, timeout=10) as client:
        login = expect_ok(client.post("/api/auth/login", json={"email": "admin@example.com", "password": "starshipnas"}))
        assert login["user"]["email"] == "admin@example.com"

        epub_result = upload_sample(client, epub, MEDIA_TYPES[".epub"])
        validate_imported_sample(client, epub_result, ".epub")

        comic_result = upload_sample(client, comic, MEDIA_TYPES[".zip"])
        validate_imported_sample(client, comic_result, ".zip")

        pdf_result = upload_sample(client, pdf, MEDIA_TYPES[".pdf"])
        validate_imported_sample(client, pdf_result, ".pdf")

        real_samples = list(discover_real_library_samples())
        if real_samples:
            print(f"Running real-library smoke with {len(real_samples)} sample(s)")
        for real_sample in real_samples:
            result = upload_sample(client, real_sample, MEDIA_TYPES[real_sample.suffix.lower()])
            validate_imported_sample(client, result, real_sample.suffix.lower())


def discover_real_library_samples() -> Iterable[Path]:
    root_value = os.environ.get("PYTHON_REAL_LIBRARY_SAMPLE_DIR")
    required = os.environ.get("REQUIRE_REAL_LIBRARY_SAMPLE_DIR") == "true"
    if not root_value:
        if required:
            raise RuntimeError("PYTHON_REAL_LIBRARY_SAMPLE_DIR is required for real-library smoke")
        return []
    root = Path(root_value).expanduser().resolve()
    if not root.is_dir():
        raise RuntimeError(f"PYTHON_REAL_LIBRARY_SAMPLE_DIR is not a directory: {root}")
    max_count = max(1, int(os.environ.get("PYTHON_REAL_LIBRARY_SAMPLE_LIMIT") or "6"))
    max_bytes = int(os.environ.get("PYTHON_REAL_LIBRARY_SAMPLE_MAX_BYTES") or str(1024 * 1024 * 1024))
    found: list[Path] = []
    for path in sorted(root.rglob("*")):
        if len(found) >= max_count:
            break
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_EXTS:
            continue
        try:
            size = path.stat().st_size
        except OSError:
            continue
        if size <= 0 or size > max_bytes:
            continue
        found.append(path)
    if required and not found:
        raise RuntimeError(f"no supported EPUB/CBZ/ZIP/PDF samples found under {root}")
    return found


def main() -> None:
    with TemporaryDirectory(prefix="shuku-python-sample-smoke-") as tmp:
        root = Path(tmp)
        monitor_root = root / "monitor"
        storage_root = root / "storage"
        inbox = root / "downloads" / "inbox"
        sample_dir = root / "samples"
        for path in [monitor_root, storage_root, inbox, sample_dir]:
            path.mkdir(parents=True, exist_ok=True)

        database_url = f"sqlite+pysqlite:///{root / 'sample-smoke.sqlite'}"
        setup_database(database_url)
        port = free_port()
        env = {
            **os.environ,
            "DATABASE_URL": database_url,
            "SESSION_SECRET": "runtime-smoke-session-secret-32chars",
            "MONITOR_ROOT": str(monitor_root),
            "STORAGE_ROOT": str(storage_root),
            "DOWNLOAD_INBOX_PATH": str(inbox),
            "AUTOMATIC_BACKUP_ENABLED": "false",
        }
        process = subprocess.Popen(
            ["uv", "run", "--extra", "dev", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
            cwd=API_ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            base_url = f"http://127.0.0.1:{port}"
            wait_for_health(base_url, process)
            run_http_flow(base_url, sample_dir)
            print("Python backend production-sample smoke ok")
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            output = process.stdout.read() if process.stdout else ""
            if output.strip():
                print(output.strip())


if __name__ == "__main__":
    main()
