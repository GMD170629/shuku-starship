#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ENV_BACKUP=""
ENV_EXISTED=false

cleanup() {
  jobs -p | xargs -r kill
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
MONITOR_ROOT="${MONITOR_ROOT:-$ROOT_DIR/books}"

case "$MONITOR_ROOT" in
  /*) ;;
  *) MONITOR_ROOT="$ROOT_DIR/$MONITOR_ROOT" ;;
esac

if [ ! -d "$MONITOR_ROOT" ]; then
  mkdir -p "$MONITOR_ROOT"
fi

DATABASE_URL="$TEST_DATABASE_URL"
export DATABASE_URL MONITOR_ROOT

ENV_BACKUP="$(mktemp)"
if [ -f .env ]; then
  ENV_EXISTED=true
  cp .env "$ENV_BACKUP"
else
  : > "$ENV_BACKUP"
fi

awk -v db="$DATABASE_URL" -v monitor="$MONITOR_ROOT" '
  BEGIN { seenDb = 0; seenMonitor = 0 }
  /^DATABASE_URL=/ { print "DATABASE_URL=" db; seenDb = 1; next }
  /^MONITOR_ROOT=/ { print "MONITOR_ROOT=" monitor; seenMonitor = 1; next }
  { print }
  END {
    if (!seenDb) print "DATABASE_URL=" db
    if (!seenMonitor) print "MONITOR_ROOT=" monitor
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
echo "  Web:          http://localhost:${WEB_PORT:-3000}"
echo "  Health check: http://localhost:${WEB_PORT:-3000}/api/health"
echo "  Database:     $TEST_DATABASE_URL"
echo "  Monitor root: $MONITOR_ROOT"

pnpm --filter @shuku/scanner dev &
pnpm --filter @shuku/scan-worker dev &
pnpm --filter @shuku/web dev &

wait
