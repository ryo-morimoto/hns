#!/usr/bin/env bash
# Deploy the Worker with the cf CLI. Auth first: npx cf auth login (device flow).
# Usage: HNS_AGENT_URL=https://poc-machine.example.com ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

[ -n "${HNS_AGENT_URL:-}" ] || { echo "set HNS_AGENT_URL to the tunnel hostname" >&2; exit 1; }
[ -f .dev.vars ] || { echo "missing .dev.vars (run ./start.sh once)" >&2; exit 1; }

npx cf auth whoami >/dev/null || { echo "not logged in: run npx cf auth login" >&2; exit 1; }

HNS_AGENT_URL="${HNS_AGENT_URL}" npx cf deploy --secrets-file .dev.vars
echo "deployed"
