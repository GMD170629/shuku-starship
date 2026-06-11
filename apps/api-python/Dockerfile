FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1

WORKDIR /app/apps/api-python

COPY apps/api-python/pyproject.toml apps/api-python/uv.lock ./
COPY apps/api-python/app ./app
COPY apps/api-python/alembic.ini ./alembic.ini
COPY apps/api-python/alembic ./alembic

RUN pip install --no-cache-dir .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
