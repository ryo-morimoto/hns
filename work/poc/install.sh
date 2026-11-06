#!/usr/bin/env bash
# Install the PoC dependencies. Run inside `nix develop` (issue 0004).
set -euo pipefail
cd "$(dirname "$0")"

# wasm-editor is a separate research tree (0010) that no check depends on.
for dir in */; do
  case "$dir" in
    wasm-editor/) continue ;;
  esac
  [ -f "$dir/package.json" ] || continue
  echo "== $dir"
  (cd "$dir" && npm ci --no-audit --no-fund)
done
