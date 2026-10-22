#!/usr/bin/env bash
# Jax Nova — one-shot launcher
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required. Install it from https://nodejs.org then rerun."
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 18 ]; then
  echo "Node $(node -v) is too old — Jax Nova needs 18.17 or newer."
  exit 1
fi

[ -f .env ] || { cp .env.example .env; echo "created .env from .env.example (all keys optional)"; }

echo "starting Jax Nova…"
exec node server/server.js
