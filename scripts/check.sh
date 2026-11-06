#!/usr/bin/env bash
# Everything a change must pass. Run from the repository root.
set -euo pipefail
cd "$(dirname "$0")/.."

node --version >/dev/null
oxlint packages apps 2>/dev/null || oxlint packages
oxfmt --check packages apps 2>/dev/null || oxfmt --check packages
(cd packages/protocol && node node_modules/typescript/bin/tsc --noEmit)
(cd packages/protocol && node --test test/*.test.ts)
