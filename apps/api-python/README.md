# Shuku Starship Python API

Python FastAPI backend and import worker for Shuku Starship. Docker deployments run this service together with the Next.js frontend in the unified `web` image.

## Local setup

```bash
cd apps/api-python
python3 -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Health check:

```bash
curl http://localhost:8000/api/health
```

Backups are manual. Use the settings page or `POST /api/backups` to create a backup archive. Backup archives include system settings and database data, but exclude reader content files and cover image files.

Torrent and magnet tasks can be submitted to qBittorrent Web API when configured through `SystemSetting` rows:

```bash
download.qbittorrent.url=http://qbittorrent:8080
download.qbittorrent.username=admin
download.qbittorrent.password=change-me
download.qbittorrent.category=shuku
download.qbittorrent.savePath=/downloads/books
```

When no qBittorrent URL is configured, torrent tasks keep the local `.torrent`/`.magnet` handoff behavior.

Run the Python import worker:

```bash
python -m app.worker.main
```

## Tests

```bash
uv run --extra dev pytest -q
```

Full migration gate from the repository root:

```bash
pnpm verify:python-backend
```

Runtime smoke from the repository root:

```bash
pnpm smoke:python-api
pnpm smoke:python-worker
pnpm smoke:python-worker-import
pnpm smoke:python-sample
PYTHON_REAL_LIBRARY_SAMPLE_DIR=/path/to/books pnpm smoke:python-real-library
```

## Unified Docker runtime

The Next.js app permanently rewrites `/api/:path*` to the local Python API process on `127.0.0.1:8000` inside the same container. The unified app startup script launches:

- `uvicorn app.main:app`
- `python -m app.worker.main`
- `node apps/web/server.js`

```bash
docker compose up --build
```

## Migration boundary

The old TypeScript backend remains in the repository for compatibility comparison only. Runtime Docker paths use Python API and Python Worker directly.
