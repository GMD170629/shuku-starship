#!/bin/sh
set -eu

missing=""

for name in "$@"; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    missing="$missing $name"
  fi
done

if [ -n "$missing" ]; then
  echo "Missing required environment variables:$missing" >&2
  exit 1
fi
