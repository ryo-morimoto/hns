#!/usr/bin/env bash
# Everything a change must pass. Run from the repository root (or `npm run check`).
set -euo pipefail
cd "$(dirname "$0")/.."

oxlint packages
oxfmt --check packages
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm run build --workspaces --if-present
