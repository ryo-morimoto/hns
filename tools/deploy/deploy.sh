#!/usr/bin/env bash
# Deploy the hns Worker with the cf CLI. Auth first: cf auth login.
set -euo pipefail

cd "$(dirname "$0")"

mode="${1:-}"
case "$mode" in
  staging|production) ;;
  *) echo "usage: $0 staging|production" >&2; exit 2 ;;
esac

secrets="${HNS_SECRETS_FILE:-$HOME/.config/hns/$mode.secrets.json}"
[ -f "$secrets" ] || { echo "missing secrets file: $secrets" >&2; exit 2; }
mode_bits="$(stat -c %a "$secrets" 2>/dev/null || stat -f %Lp "$secrets" 2>/dev/null || true)"
[ "$mode_bits" = "600" ] || { echo "chmod 600 $secrets (current: ${mode_bits:-unknown})" >&2; exit 2; }

: "${HNS_AGENT_URL:?set HNS_AGENT_URL to the tunnel URL}"
: "${HNS_MODEL:?set HNS_MODEL to the provider model}"
export HNS_AGENT_URL HNS_MODEL

../../node_modules/.bin/cf auth whoami >/dev/null || { echo "not logged in: run cf auth login" >&2; exit 2; }

exec ../../node_modules/.bin/cf deploy --mode "$mode" --secrets-file "$secrets"
