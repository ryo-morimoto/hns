#!/usr/bin/env bash
# Start the machine agent and the local dev server (cf dev) for the PoC.
# Run inside `nix develop` from this directory:  ./start.sh
set -euo pipefail
cd "$(dirname "$0")"

ROOT_DIR="${HNS_ROOT:-../../../.work/cf-poc-root}"
mkdir -p "$ROOT_DIR"
ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"

if [ ! -f .dev.vars ]; then
  secret="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  printf 'HNS_AGENT_SECRET=%s\n' "$secret" > .dev.vars
  echo "wrote .dev.vars"
fi
secret="$(sed -n 's/^HNS_AGENT_SECRET=//p' .dev.vars)"

HNS_ROOT="$ROOT_DIR" HNS_AGENT_SECRET="$secret" HNS_AGENT_PORT=8788 node agent/server.mjs &
agent=$!
trap 'kill $agent 2>/dev/null || true' EXIT

npx cf dev --port 8787
