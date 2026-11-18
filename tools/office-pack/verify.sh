#!/usr/bin/env bash
# Checks a built pack against its own manifest (C1) and the parts D102 requires to be conveyed
# (C5). Exit 0 = usable; exit 1 = do not run it, and the missing list says why.
#
#   tools/office-pack/verify.sh               verify <repo>/office-pack
#   tools/office-pack/verify.sh /some/pack    verify a pack at that path
#
# 0236's officeEngine runs this before it answers "available": a pack whose binary no longer matches
# its manifest is not a pack (C2), and one without its notices is not one hns may convey (C5).
set -euo pipefail

readonly DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO="$(cd "$DIR/../.." && pwd)"
readonly PACK="${1:-${IBIS_OFFICE_PACK_DIR:-$REPO/office-pack}}"

if [[ ! -d "$PACK" ]]; then
  printf 'office-pack: no pack at %s (run tools/office-pack/build.sh)\n' "$PACK" >&2
  exit 1
fi
exec node "$DIR/pack.mjs" verify --pack "$PACK"
