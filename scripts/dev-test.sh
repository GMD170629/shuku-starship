#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ENV_BACKUP=""
ENV_EXISTED=false

cleanup() {
  for pid in $(jobs -p); do
    kill "$pid" 2>/dev/null || true
  done
  if [ -n "$ENV_BACKUP" ]; then
    if [ "$ENV_EXISTED" = "true" ]; then
      cp "$ENV_BACKUP" .env
    else
      rm -f .env
    fi
    rm -f "$ENV_BACKUP"
  fi
}
trap cleanup INT TERM EXIT

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

TEST_DATABASE_URL="${TEST_DATABASE_URL:-mysql://shuku:shuku@localhost:3306/shuku_starship_test}"
TEST_PYTHON_DATABASE_URL="${TEST_PYTHON_DATABASE_URL:-}"
API_PYTHON_PORT="${API_PYTHON_PORT:-8000}"
WEB_PORT="${WEB_PORT:-3000}"
MONITOR_ROOT="${MONITOR_ROOT:-$ROOT_DIR/books}"
STORAGE_ROOT="${STORAGE_ROOT:-$ROOT_DIR/storage}"
DOWNLOAD_INBOX_PATH="${DOWNLOAD_INBOX_PATH:-$STORAGE_ROOT/downloads/inbox}"
SESSION_SECRET="${SESSION_SECRET:-dev-test-session-secret-change-me-at-least-32-chars}"

case "$MONITOR_ROOT" in
  /*) ;;
  *) MONITOR_ROOT="$ROOT_DIR/$MONITOR_ROOT" ;;
esac

if [ ! -d "$MONITOR_ROOT" ]; then
  mkdir -p "$MONITOR_ROOT"
fi
mkdir -p "$STORAGE_ROOT" "$DOWNLOAD_INBOX_PATH"

if [ -z "$TEST_PYTHON_DATABASE_URL" ]; then
  case "$TEST_DATABASE_URL" in
    mysql+pymysql://*) TEST_PYTHON_DATABASE_URL="$TEST_DATABASE_URL" ;;
    mysql://*) TEST_PYTHON_DATABASE_URL="mysql+pymysql://${TEST_DATABASE_URL#mysql://}" ;;
    *) TEST_PYTHON_DATABASE_URL="$TEST_DATABASE_URL" ;;
  esac
fi

DATABASE_URL="$TEST_DATABASE_URL"
export DATABASE_URL MONITOR_ROOT STORAGE_ROOT DOWNLOAD_INBOX_PATH SESSION_SECRET WEB_PORT API_PYTHON_PORT

ENV_BACKUP="$(mktemp)"
if [ -f .env ]; then
  ENV_EXISTED=true
  cp .env "$ENV_BACKUP"
else
  : > "$ENV_BACKUP"
fi

awk \
  -v db="$DATABASE_URL" \
  -v monitor="$MONITOR_ROOT" \
  -v storage="$STORAGE_ROOT" \
  -v inbox="$DOWNLOAD_INBOX_PATH" \
  -v secret="$SESSION_SECRET" \
  -v apiPort="$API_PYTHON_PORT" '
  BEGIN { seenDb = 0; seenMonitor = 0; seenStorage = 0; seenInbox = 0; seenSecret = 0; seenApiPort = 0 }
  /^DATABASE_URL=/ { print "DATABASE_URL=" db; seenDb = 1; next }
  /^MONITOR_ROOT=/ { print "MONITOR_ROOT=" monitor; seenMonitor = 1; next }
  /^STORAGE_ROOT=/ { print "STORAGE_ROOT=" storage; seenStorage = 1; next }
  /^DOWNLOAD_INBOX_PATH=/ { print "DOWNLOAD_INBOX_PATH=" inbox; seenInbox = 1; next }
  /^SESSION_SECRET=/ { print "SESSION_SECRET=" secret; seenSecret = 1; next }
  /^API_PYTHON_PORT=/ { print "API_PYTHON_PORT=" apiPort; seenApiPort = 1; next }
  { print }
  END {
    if (!seenDb) print "DATABASE_URL=" db
    if (!seenMonitor) print "MONITOR_ROOT=" monitor
    if (!seenStorage) print "STORAGE_ROOT=" storage
    if (!seenInbox) print "DOWNLOAD_INBOX_PATH=" inbox
    if (!seenSecret) print "SESSION_SECRET=" secret
    if (!seenApiPort) print "API_PYTHON_PORT=" apiPort
  }
' "$ENV_BACKUP" > .env

if [ "${SKIP_DOCKER_MYSQL:-false}" != "true" ]; then
  docker compose up -d mysql
  echo "Waiting for MySQL..."
  i=0
  until docker exec shuku-mysql mysqladmin ping -h127.0.0.1 -uroot -proot --silent; do
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
      echo "MySQL did not become ready in time." >&2
      exit 1
    fi
    sleep 1
  done
  docker exec shuku-mysql mysql -uroot -proot -e "CREATE DATABASE IF NOT EXISTS shuku_starship_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL PRIVILEGES ON shuku_starship_test.* TO 'shuku'@'%'; FLUSH PRIVILEGES;"
fi

pnpm --filter @shuku/database prisma:push
pnpm db:seed

echo "Starting test service:"
echo "  Web:          http://localhost:$WEB_PORT"
echo "  Health check: http://localhost:$WEB_PORT/api/health"
echo "  Python API:   http://127.0.0.1:$API_PYTHON_PORT"
echo "  Database:     $TEST_DATABASE_URL"
echo "  Python DB:    $TEST_PYTHON_DATABASE_URL"
echo "  Monitor root: $MONITOR_ROOT"
echo "  Storage root: $STORAGE_ROOT"

(
  cd apps/api-python
  DATABASE_URL="$TEST_PYTHON_DATABASE_URL" \
    MONITOR_ROOT="$MONITOR_ROOT" \
    STORAGE_ROOT="$STORAGE_ROOT" \
    DOWNLOAD_INBOX_PATH="$DOWNLOAD_INBOX_PATH" \
    SESSION_SECRET="$SESSION_SECRET" \
    SECURE_COOKIES="${SECURE_COOKIES:-false}" \
    AUTOMATIC_BACKUP_ENABLED="${AUTOMATIC_BACKUP_ENABLED:-false}" \
    uv run --extra dev uvicorn app.main:app --host 127.0.0.1 --port "$API_PYTHON_PORT"
) &

echo "Waiting for Python API..."
i=0
until node -e "fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" "http://127.0.0.1:$API_PYTHON_PORT/api/health"; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "Python API did not become ready in time." >&2
    exit 1
  fi
  sleep 1
done

(
  cd apps/api-python
  DATABASE_URL="$TEST_PYTHON_DATABASE_URL" \
    MONITOR_ROOT="$MONITOR_ROOT" \
    STORAGE_ROOT="$STORAGE_ROOT" \
    DOWNLOAD_INBOX_PATH="$DOWNLOAD_INBOX_PATH" \
    SESSION_SECRET="$SESSION_SECRET" \
    MONITOR_REFRESH_INTERVAL_MS="${MONITOR_REFRESH_INTERVAL_MS:-10000}" \
    uv run --extra dev python -m app.worker.main
) &

pnpm --filter @shuku/web exec next dev -p "$WEB_PORT" &

wait
