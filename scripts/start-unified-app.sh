#!/bin/sh
set -eu

ROOT_DIR="${ROOT_DIR:-/app}"
API_PYTHON_PORT="${API_PYTHON_PORT:-8000}"
WEB_PORT="${PORT:-3000}"
PYTHON_API_DIR="${PYTHON_API_DIR:-$ROOT_DIR/apps/api-python}"
NEXT_SERVER="${NEXT_SERVER:-$ROOT_DIR/apps/web/server.js}"
RUN_DB_PUSH="${RUN_DB_PUSH:-false}"
RUN_SEED="${RUN_SEED:-true}"

derive_python_database_url() {
  if [ -n "${PYTHON_DATABASE_URL:-}" ]; then
    printf '%s' "$PYTHON_DATABASE_URL"
    return
  fi
  case "${DATABASE_URL:-}" in
    mysql+pymysql://*) printf '%s' "$DATABASE_URL" ;;
    mysql://*) printf 'mysql+pymysql://%s' "${DATABASE_URL#mysql://}" ;;
    *) printf '%s' "${DATABASE_URL:-}" ;;
  esac
}

shutdown() {
  trap - INT TERM EXIT
  for pid in ${API_PID:-} ${WORKER_PID:-} ${WEB_PID:-}; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait ${API_PID:-} ${WORKER_PID:-} ${WEB_PID:-} 2>/dev/null || true
}

trap shutdown INT TERM EXIT

"$ROOT_DIR/scripts/require-env.sh" DATABASE_URL SESSION_SECRET MONITOR_ROOT
mkdir -p "$MONITOR_ROOT" "$ROOT_DIR/storage/covers" "$ROOT_DIR/storage/indexes" "$ROOT_DIR/storage/temp" "$ROOT_DIR/storage/logs" "$ROOT_DIR/storage/downloads/inbox"

export HOSTNAME="${HOSTNAME:-0.0.0.0}"
export PORT="$WEB_PORT"
export API_PYTHON_PORT
export STORAGE_ROOT="${STORAGE_ROOT:-$ROOT_DIR/storage}"
export DOWNLOAD_INBOX_PATH="${DOWNLOAD_INBOX_PATH:-$STORAGE_ROOT/downloads/inbox}"
export PYTHON_DATABASE_URL="$(derive_python_database_url)"

if [ "$RUN_DB_PUSH" = "true" ]; then
  pnpm --dir "$ROOT_DIR/migrator" --filter @shuku/database exec prisma db push --accept-data-loss
fi

if [ "$RUN_SEED" = "true" ]; then
  node "$ROOT_DIR/scripts/seed.mjs"
fi

(
  cd "$PYTHON_API_DIR"
  DATABASE_URL="$PYTHON_DATABASE_URL" uvicorn app.main:app --host 127.0.0.1 --port "$API_PYTHON_PORT"
) &
API_PID="$!"

(
  cd "$PYTHON_API_DIR"
  DATABASE_URL="$PYTHON_DATABASE_URL" python -m app.worker.main
) &
WORKER_PID="$!"

node "$NEXT_SERVER" &
WEB_PID="$!"

while :; do
  for pid in "$API_PID" "$WORKER_PID" "$WEB_PID"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" || exit $?
      exit 1
    fi
  done
  sleep 2
done
