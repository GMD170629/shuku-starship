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

TEST_PYTHON_DATABASE_URL="${TEST_PYTHON_DATABASE_URL:-}"
PYTHON_API_PORT="8000"
WEB_PORT="${WEB_PORT:-3000}"
MONITOR_ROOT="${MONITOR_ROOT:-$ROOT_DIR/books}"
STORAGE_ROOT="${STORAGE_ROOT:-$ROOT_DIR/storage}"
DOWNLOAD_INBOX_PATH="${DOWNLOAD_INBOX_PATH:-$STORAGE_ROOT/downloads/inbox}"
SESSION_SECRET="${SESSION_SECRET:-dev-test-session-secret-change-me-at-least-32-chars}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-change-root-me}"
MYSQL_DATABASE="${TEST_MYSQL_DATABASE:-shuku_starship_test}"
MYSQL_USER="${TEST_MYSQL_USER:-shuku}"
MYSQL_PASSWORD="${TEST_MYSQL_PASSWORD:-shuku}"
MYSQL_PORT="${TEST_MYSQL_PORT:-13306}"
TEST_DATABASE_URL="${TEST_DATABASE_URL:-mysql://$MYSQL_USER:$MYSQL_PASSWORD@localhost:$MYSQL_PORT/$MYSQL_DATABASE}"

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
export DATABASE_URL MONITOR_ROOT STORAGE_ROOT DOWNLOAD_INBOX_PATH SESSION_SECRET WEB_PORT MYSQL_ROOT_PASSWORD MYSQL_DATABASE MYSQL_USER MYSQL_PASSWORD MYSQL_PORT

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
  -v mysqlRootPassword="$MYSQL_ROOT_PASSWORD" \
  -v mysqlDatabase="$MYSQL_DATABASE" \
  -v mysqlUser="$MYSQL_USER" \
  -v mysqlPassword="$MYSQL_PASSWORD" \
  -v mysqlPort="$MYSQL_PORT" \
  -v secret="$SESSION_SECRET" '
  BEGIN { seenDb = 0; seenMonitor = 0; seenStorage = 0; seenInbox = 0; seenSecret = 0; seenMysqlRootPassword = 0; seenMysqlDatabase = 0; seenMysqlUser = 0; seenMysqlPassword = 0; seenMysqlPort = 0 }
  /^DATABASE_URL=/ { print "DATABASE_URL=" db; seenDb = 1; next }
  /^MONITOR_ROOT=/ { print "MONITOR_ROOT=" monitor; seenMonitor = 1; next }
  /^STORAGE_ROOT=/ { print "STORAGE_ROOT=" storage; seenStorage = 1; next }
  /^DOWNLOAD_INBOX_PATH=/ { print "DOWNLOAD_INBOX_PATH=" inbox; seenInbox = 1; next }
  /^SESSION_SECRET=/ { print "SESSION_SECRET=" secret; seenSecret = 1; next }
  /^MYSQL_ROOT_PASSWORD=/ { print "MYSQL_ROOT_PASSWORD=" mysqlRootPassword; seenMysqlRootPassword = 1; next }
  /^MYSQL_DATABASE=/ { print "MYSQL_DATABASE=" mysqlDatabase; seenMysqlDatabase = 1; next }
  /^MYSQL_USER=/ { print "MYSQL_USER=" mysqlUser; seenMysqlUser = 1; next }
  /^MYSQL_PASSWORD=/ { print "MYSQL_PASSWORD=" mysqlPassword; seenMysqlPassword = 1; next }
  /^MYSQL_PORT=/ { print "MYSQL_PORT=" mysqlPort; seenMysqlPort = 1; next }
  { print }
  END {
    if (!seenDb) print "DATABASE_URL=" db
    if (!seenMonitor) print "MONITOR_ROOT=" monitor
    if (!seenStorage) print "STORAGE_ROOT=" storage
    if (!seenInbox) print "DOWNLOAD_INBOX_PATH=" inbox
    if (!seenSecret) print "SESSION_SECRET=" secret
    if (!seenMysqlRootPassword) print "MYSQL_ROOT_PASSWORD=" mysqlRootPassword
    if (!seenMysqlDatabase) print "MYSQL_DATABASE=" mysqlDatabase
    if (!seenMysqlUser) print "MYSQL_USER=" mysqlUser
    if (!seenMysqlPassword) print "MYSQL_PASSWORD=" mysqlPassword
    if (!seenMysqlPort) print "MYSQL_PORT=" mysqlPort
  }
' "$ENV_BACKUP" > .env

if [ "${SKIP_DOCKER_MYSQL:-false}" != "true" ]; then
  docker compose up -d mysql
  MYSQL_CONTAINER_ID="$(docker compose ps -q mysql)"
  if [ -z "$MYSQL_CONTAINER_ID" ]; then
    echo "Could not find the mysql container started by docker compose." >&2
    exit 1
  fi
  echo "Waiting for MySQL..."
  i=0
  until docker exec "$MYSQL_CONTAINER_ID" mysqladmin ping -h127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent; do
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
      echo "MySQL did not become ready in time." >&2
      exit 1
    fi
    sleep 1
  done
  MYSQL_PASSWORD_SQL="$(printf "%s" "$MYSQL_PASSWORD" | sed "s/'/''/g")"
  MYSQL_DATABASE_SQL="$(printf "%s" "$MYSQL_DATABASE" | sed "s/\`/\`\`/g")"
  docker exec "$MYSQL_CONTAINER_ID" mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "CREATE DATABASE IF NOT EXISTS \`$MYSQL_DATABASE_SQL\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER IF NOT EXISTS '$MYSQL_USER'@'%' IDENTIFIED BY '$MYSQL_PASSWORD_SQL'; ALTER USER '$MYSQL_USER'@'%' IDENTIFIED BY '$MYSQL_PASSWORD_SQL'; GRANT ALL PRIVILEGES ON \`$MYSQL_DATABASE_SQL\`.* TO '$MYSQL_USER'@'%'; CREATE USER IF NOT EXISTS '$MYSQL_USER'@'localhost' IDENTIFIED BY '$MYSQL_PASSWORD_SQL'; ALTER USER '$MYSQL_USER'@'localhost' IDENTIFIED BY '$MYSQL_PASSWORD_SQL'; GRANT ALL PRIVILEGES ON \`$MYSQL_DATABASE_SQL\`.* TO '$MYSQL_USER'@'localhost'; FLUSH PRIVILEGES;"
fi

(
  cd apps/api-python
  DATABASE_URL="$TEST_PYTHON_DATABASE_URL" \
    ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}" \
    ADMIN_PASSWORD="${ADMIN_PASSWORD:-starshipnas}" \
    uv run python -m app.db.bootstrap
)

echo "Starting test service:"
echo "  Web:          http://localhost:$WEB_PORT"
echo "  Health check: http://localhost:$WEB_PORT/api/health"
echo "  Python API:   http://127.0.0.1:$PYTHON_API_PORT"
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
    uv run --extra dev uvicorn app.main:app --host 127.0.0.1 --port "$PYTHON_API_PORT"
) &

echo "Waiting for Python API..."
i=0
until node -e "fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" "http://127.0.0.1:$PYTHON_API_PORT/api/health"; do
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
