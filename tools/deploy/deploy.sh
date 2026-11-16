#!/usr/bin/env bash
# Deploy the hns Workers with the cf CLI. Auth first: cf auth login.
# Order matters: the gateway is deployed first so the main Worker's service binding has a target.
set -euo pipefail

cd "$(dirname "$0")"

mode="${1:-}"
case "$mode" in
  staging|production) ;;
  *) echo "usage: $0 staging|production" >&2; exit 2 ;;
esac

# cf resolves the project from the directory it runs in, so keep both files absolute.
abspath() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$PWD" "$1" ;; esac; }

secrets="$(abspath "${HNS_SECRETS_FILE:-$HOME/.config/hns/$mode.secrets.json}")"
gateway_secrets="$(abspath "${HNS_GATEWAY_SECRETS_FILE:-$HOME/.config/hns/$mode.gateway.secrets.json}")"

# The main Worker never gets a provider key; the gateway Worker only gets provider keys.
main_keys=(HNS_AGENT_SECRET HNS_SESSION_SECRET HNS_SERVICE_KEY)
gateway_keys=(OLLAMA_CLOUD_API_KEY OPENCODE_GO_API_KEY)

check_secrets_file() {
  local file="$1"
  shift
  [ -f "$file" ] || { echo "missing secrets file: $file" >&2; exit 2; }
  local bits
  bits="$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file" 2>/dev/null || true)"
  [ "$bits" = "600" ] || { echo "chmod 600 $file (current: ${bits:-unknown})" >&2; exit 2; }
  node -e '
  const fs = require("node:fs");
  const allowed = new Set(process.argv.slice(2));
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) throw new Error("unexpected secret: " + key);
  }
  for (const key of allowed) {
    if (!(key in data)) throw new Error("missing secret: " + key);
  }
' "$file" "$@" || { echo "invalid secrets file: $file" >&2; exit 2; }
}

check_secrets_file "$secrets" "${main_keys[@]}"
check_secrets_file "$gateway_secrets" "${gateway_keys[@]}"

: "${HNS_AGENT_URL:?set HNS_AGENT_URL to the tunnel URL}"
: "${HNS_MODEL:?set HNS_MODEL to the provider model}"
export HNS_AGENT_URL HNS_MODEL

../../node_modules/.bin/cf auth whoami >/dev/null || { echo "not logged in: run cf auth login" >&2; exit 2; }

( cd gateway && ../../../node_modules/.bin/cf deploy --mode "$mode" --secrets-file "$gateway_secrets" )
exec ../../node_modules/.bin/cf deploy --mode "$mode" --secrets-file "$secrets"
