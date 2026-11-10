#!/usr/bin/env bash
# Run the machine agent behind a remotely-managed Cloudflare Tunnel.
# Tunnel token: $CF_TUNNEL_TOKEN_FILE or ~/.config/hns/cloudflare-tunnel-token
# The tunnel's public hostname must point at http://127.0.0.1:8788.
set -euo pipefail
cd "$(dirname "$0")"

token_file="${CF_TUNNEL_TOKEN_FILE:-$HOME/.config/hns/cloudflare-tunnel-token}"
[ -f "$token_file" ] || { echo "missing tunnel token: $token_file" >&2; exit 1; }
[ -f .dev.vars ] || { echo "missing .dev.vars (run ./start.sh once)" >&2; exit 1; }

secret="$(sed -n 's/^HNS_AGENT_SECRET=//p' .dev.vars)"
HNS_ROOT="${HNS_ROOT:-../../../.work/cf-poc-root}" HNS_AGENT_SECRET="$secret" HNS_AGENT_PORT=8788 \
  node agent/server.mjs &
agent=$!
trap 'kill $agent 2>/dev/null || true' EXIT

XDG_CACHE_HOME="$PWD/../../../.work/nix-cache" nix shell nixpkgs#cloudflared --command \
  cloudflared tunnel run --token "$(cat "$token_file")"
