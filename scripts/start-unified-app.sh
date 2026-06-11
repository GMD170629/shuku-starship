#!/bin/sh
set -eu

ROOT_DIR="${ROOT_DIR:-/app}"
PYTHON_API_PORT="8000"
WEB_PORT="${PORT:-3000}"
PYTHON_API_DIR="${PYTHON_API_DIR:-$ROOT_DIR/apps/api-python}"
NEXT_SERVER="${NEXT_SERVER:-$ROOT_DIR/apps/web/server.js}"

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

"$ROOT_DIR/scripts/require-env.sh" DATABASE_URL
export STORAGE_ROOT="${STORAGE_ROOT:-$ROOT_DIR/storage}"
export DOWNLOAD_INBOX_PATH="${DOWNLOAD_INBOX_PATH:-$STORAGE_ROOT/downloads/inbox}"
export MONITOR_ROOT="${MONITOR_ROOT:-/monitor}"
mkdir -p "$MONITOR_ROOT" "$STORAGE_ROOT/covers" "$STORAGE_ROOT/indexes" "$STORAGE_ROOT/temp" "$STORAGE_ROOT/logs" "$DOWNLOAD_INBOX_PATH" "$STORAGE_ROOT/secrets"

if [ -z "${SESSION_SECRET:-}" ]; then
  secret_file="$STORAGE_ROOT/secrets/session-secret"
  if [ ! -s "$secret_file" ]; then
    umask 077
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex 32 > "$secret_file"
    else
      node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "$secret_file"
    fi
  fi
  SESSION_SECRET="$(tr -d '\r\n' < "$secret_file")"
  export SESSION_SECRET
fi

export HOSTNAME="${HOSTNAME:-0.0.0.0}"
export PORT="$WEB_PORT"
export PYTHON_DATABASE_URL="$(derive_python_database_url)"

(
  cd "$PYTHON_API_DIR"
  DATABASE_URL="$PYTHON_DATABASE_URL" uvicorn app.main:app --host 127.0.0.1 --port "$PYTHON_API_PORT"
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
