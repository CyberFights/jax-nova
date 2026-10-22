#!/bin/sh
# ---------------------------------------------------------------------------
# Fixes the classic Railway volume problem: a volume mounted at /data arrives
# owned by root, but the app runs as the unprivileged `node` user. When we
# start as root we take ownership of the data dir, then drop privileges.
#
# If we are already non-root (local `docker run --user`), or the volume is
# read-only, we skip the chown and the server still boots — media writes fall
# back to inline data URLs.
# ---------------------------------------------------------------------------
set -e

DATA_DIR="${JAX_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  if [ -x /sbin/su-exec ]; then
    exec su-exec node "$@"
  fi
  # no su-exec available — keep going as root rather than failing the deploy
  echo "[jax] su-exec missing, running as root" >&2
fi

exec "$@"
