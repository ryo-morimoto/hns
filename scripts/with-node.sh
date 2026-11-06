#!/usr/bin/env bash
# Run a command with Node from the Nix store and a repo-local npm cache.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  NODE=$(ls -d /nix/store/*nodejs-24*/bin/node 2>/dev/null | head -1 || true)
  if [ -z "${NODE:-}" ]; then
    echo "with-node: node not found" >&2
    exit 1
  fi
  export PATH="$(dirname "$NODE"):$PATH"
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
export npm_config_cache="$ROOT/.work/npm-cache"

exec "$@"
