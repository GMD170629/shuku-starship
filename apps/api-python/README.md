# Shuku Starship Python API

Standalone Python backend prototype for the Shuku Starship migration. This directory is additive and is not wired into the existing Next.js app yet.

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

## Tests

```bash
pytest
```

## Migration boundary

This service does not modify the existing Next.js runtime path. Unified `/api` routing will be added only after compatible API coverage is implemented and tested.
