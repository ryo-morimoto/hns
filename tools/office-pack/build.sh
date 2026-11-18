#!/usr/bin/env bash
# Builds the Office engine pack (0235): the ibisOffice release plus everything it needs to run
# where hns runs it, with the versions and digests that docs/office.md §11's manifest records.
#
# Every input is pinned. The release binary, the fonts and the AppImage are fetched at a fixed
# version and checked against a digest; the X11 libraries and the software Vulkan driver come
# from this host's /nix/store and are named by their store path. Nothing reaches for "the
# system's" copy of a library: a pack that quietly picked up a host library would pass on this
# machine and fail on the next, which is the failure this issue exists to remove.
#
#   tools/office-pack/build.sh                   build <repo>/office-pack (about 300 MB)
#   IBIS_OFFICE_PACK_DIR=$PWD/p build.sh         build elsewhere (this is what CI does)
#   IBIS_OFFICE_PACK_NO_STORE=1 build.sh         omit the lib/store mirror (see README)
#
# The same inputs produce the same manifest.json: it names every file by content digest, and T3
# runs this twice and compares the two.
set -euo pipefail
umask 022

readonly DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO="$(cd "$DIR/../.." && pwd)"

# --- pinned inputs ---------------------------------------------------------------------------
# Version and digest of the one upstream artefact. An upgrade edits this file, never an argument:
# the digest is what ties the conveyed binary to the source SOURCE.md names (AGPL section 7(b)).
readonly IBIS_OFFICE_VERSION="0.8.7"
readonly IBIS_OFFICE_REPOSITORY="ibisjp/ibis-office"
# 51,472,144 bytes; the digest GitHub's release API publishes for this asset and the value the
# spike measured (work/research/ibisoffice-spike/README.md, S12).
readonly IBIS_OFFICE_SHA256="${IBIS_OFFICE_SHA256:-0c6b15d93b285cd87fece776ea6be0d79d826c8888f2864dc7f02033330085dd}"

# Fonts. IPAexGothic and Noto Sans JP are the CJK faces. DejaVu Sans is not a design choice but
# the base face the engine's text system resolves .SystemUIFont to: without it the engine
# refuses to start at all, and with a CJK face absent it substitutes silently (spike S17, C3).
readonly IPAEX_URL="https://moji.or.jp/wp-content/ipafont/IPAexfont/ipaexg00401.zip"
readonly IPAEX_SHA256="4ab6fee94bf6f94b3eeb31be2b73c559f738dc6b336d722d5301b1f3f592f850"
readonly NOTO_SANS_JP_URL="https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/16_NotoSansJP.zip"
readonly NOTO_SANS_JP_SHA256="2bbdd2c20f30670b39ca735c96d75f1fdabdb348103e43b820cf17701fd22b18"
readonly DEJAVU_URL="https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.tar.bz2"
readonly DEJAVU_SHA256="fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7"

# The runtime libraries. NixOS ships these as store paths, which is the only identity this host
# can offer; the manifest writes the paths down so a pack built elsewhere names its own.
readonly MESA_VERSION_DEFAULT="26.1.5"
# 1.4.341.0 does not load lavapipe off a path outside /nix/store: PDF still comes out and PNG
# fails with "no HeadlessRenderer configured" (measured in 0235). 1.4.363.0 does, so render works
# from the pack's own lib/ with nothing bound from the host.
readonly VULKAN_LOADER_VERSION_DEFAULT="1.4.363.0"

readonly PACK_DIR="${IBIS_OFFICE_PACK_DIR:-$REPO/office-pack}"
readonly CACHE_DIR="${IBIS_OFFICE_CACHE_DIR:-$REPO/.cache/office-pack}"
readonly WORK="$CACHE_DIR/work"
readonly NODE_HELPER="$DIR/pack.mjs"

log() { printf 'office-pack: %s\n' "$*" >&2; }
die() {
  printf 'office-pack: %s\n' "$*" >&2
  exit 1
}

# --- prerequisites ----------------------------------------------------------------------------
for tool in curl sha256sum unzip tar node; do
  command -v "$tool" >/dev/null || die "$tool is required"
done
case "$(sha256sum --version 2>&1 || true)" in
  *"GNU coreutils"*) ;;
  *) die "sha256sum must be GNU coreutils; its output format is what the manifest copies" ;;
esac
[[ "$(uname -m)" == "x86_64" ]] || die "the pinned release is x86_64 only (this host is $(uname -m))"

# --- helpers ----------------------------------------------------------------------------------
fetch_and_check() {
  local url=$1 digest=$2 dest=$3
  if [[ -f "$dest" && "$(sha256sum "$dest" | cut -d' ' -f1)" == "$digest" ]]; then
    log "using cached $(basename "$dest")"
    return
  fi
  log "fetching $url"
  mkdir -p "$(dirname "$dest")"
  curl -fsSL --retry 3 -o "$dest.part" "$url"
  local got
  got="$(sha256sum "$dest.part" | cut -d' ' -f1)"
  if [[ "$got" != "$digest" ]]; then
    rm -f "$dest.part"
    die "$url: sha256 is $got, expected $digest"
  fi
  mv "$dest.part" "$dest"
}

store_path_of() {
  local name=$1 version=$2 override=$3
  local found
  found="$(compgen -G "/nix/store/*-$name-$version" | head -n 1 || true)"
  [[ -n "$found" ]] || die "$name $version is not in /nix/store ($override names one)"
  printf '%s' "$found"
}

# --- build ------------------------------------------------------------------------------------
log "pack: $PACK_DIR (ibisOffice $IBIS_OFFICE_VERSION)"
mkdir -p "$CACHE_DIR/inputs" "$WORK"

readonly APPIMAGE="$CACHE_DIR/inputs/ibisOffice-$IBIS_OFFICE_VERSION-Linux.AppImage"
fetch_and_check \
  "https://github.com/$IBIS_OFFICE_REPOSITORY/releases/download/v$IBIS_OFFICE_VERSION/ibisOffice-$IBIS_OFFICE_VERSION-Linux.AppImage" \
  "$IBIS_OFFICE_SHA256" "$APPIMAGE"
chmod +x "$APPIMAGE"

# 1. The engine. The release's bytes are conveyed as they are; only their path changes. FUSE is
# not needed: the AppImage's embedded squashfs is what --appimage-extract unpacks.
rm -rf "$WORK/engine"
mkdir -p "$WORK/engine"
( cd "$WORK/engine" && "$APPIMAGE" --appimage-extract >/dev/null )
readonly ENGINE_BIN="$WORK/engine/squashfs-root/usr/bin/ibisOffice"
[[ -x "$ENGINE_BIN" ]] || die "the release archive has no usr/bin/ibisOffice"

# 2. Fonts.
fetch_and_check "$IPAEX_URL" "$IPAEX_SHA256" "$CACHE_DIR/inputs/ipaexg00401.zip"
fetch_and_check "$NOTO_SANS_JP_URL" "$NOTO_SANS_JP_SHA256" "$CACHE_DIR/inputs/NotoSansJP.zip"
fetch_and_check "$DEJAVU_URL" "$DEJAVU_SHA256" "$CACHE_DIR/inputs/dejavu-fonts-ttf-2.37.tar.bz2"
rm -rf "$WORK/fonts"
mkdir -p "$WORK/fonts"
unzip -q -o "$CACHE_DIR/inputs/ipaexg00401.zip" -d "$WORK/fonts/ipaex"
unzip -q -o "$CACHE_DIR/inputs/NotoSansJP.zip" -d "$WORK/fonts/noto"
tar -xjf "$CACHE_DIR/inputs/dejavu-fonts-ttf-2.37.tar.bz2" -C "$WORK/fonts"

# 3. The libraries the release does not bundle (spike S12: libxcb, libxkbcommon and
# libxkbcommon-x11 are absent from the AppImage) and the software Vulkan driver PNG needs (S12b).
readonly MESA="${HNS_OFFICE_MESA:-$(store_path_of mesa "$MESA_VERSION_DEFAULT" HNS_OFFICE_MESA)}"
readonly VULKAN_LOADER="${HNS_OFFICE_VULKAN_LOADER:-$(store_path_of vulkan-loader "$VULKAN_LOADER_VERSION_DEFAULT" HNS_OFFICE_VULKAN_LOADER)}"
log "mesa: $MESA"
log "vulkan-loader: $VULKAN_LOADER"

# --- stage ------------------------------------------------------------------------------------
rm -rf "$PACK_DIR"
mkdir -p "$PACK_DIR/bin" "$PACK_DIR/fonts" "$PACK_DIR/lib" "$PACK_DIR/share/vulkan/icd.d" \
  "$PACK_DIR/var/cache/fontconfig" "$PACK_DIR/legal"

install -m 0755 "$ENGINE_BIN" "$PACK_DIR/bin/ibisOffice"
install -m 0644 "$WORK/fonts/ipaex/ipaexg00401/ipaexg.ttf" "$PACK_DIR/fonts/ipaexg.ttf"
install -m 0644 "$WORK/fonts/noto/NotoSansJP-Regular.otf" "$PACK_DIR/fonts/NotoSansJP-Regular.otf"
install -m 0644 "$WORK/fonts/noto/NotoSansJP-Bold.otf" "$PACK_DIR/fonts/NotoSansJP-Bold.otf"
install -m 0644 "$WORK/fonts/dejavu-fonts-ttf-2.37/ttf/DejaVuSans.ttf" "$PACK_DIR/fonts/DejaVuSans.ttf"
install -m 0644 "$WORK/fonts/ipaex/ipaexg00401/IPA_Font_License_Agreement_v1.0.txt" \
  "$PACK_DIR/legal/LICENSE-IPAexGothic.txt"
install -m 0644 "$WORK/fonts/noto/LICENSE" "$PACK_DIR/legal/LICENSE-NotoSansJP.txt"
install -m 0644 "$WORK/fonts/dejavu-fonts-ttf-2.37/LICENSE" "$PACK_DIR/legal/LICENSE-DejaVu.txt"

node "$NODE_HELPER" libraries \
  --engine "$ENGINE_BIN" \
  --vulkan-loader "$VULKAN_LOADER" \
  --mesa "$MESA" \
  --pack "$PACK_DIR" \
  --report "$WORK/libs.tsv" \
  --store-mirror "${IBIS_OFFICE_PACK_NO_STORE:-0}"

node "$NODE_HELPER" icd --mesa "$MESA" --pack "$PACK_DIR"

node "$NODE_HELPER" fonts-conf --pack "$PACK_DIR"

# --- legal (D102) -----------------------------------------------------------------------------
node "$NODE_HELPER" legal \
  --pack "$PACK_DIR" \
  --version "$IBIS_OFFICE_VERSION" \
  --repository "$IBIS_OFFICE_REPOSITORY" \
  --appimage-sha256 "$IBIS_OFFICE_SHA256" \
  --engine-dir "$WORK/engine/squashfs-root"

# --- manifest (docs/office.md section 11) -----------------------------------------------------
node "$NODE_HELPER" manifest \
  --pack "$PACK_DIR" \
  --version "$IBIS_OFFICE_VERSION" \
  --report "$WORK/libs.tsv" \
  --mesa "$MESA" \
  --vulkan-loader "$VULKAN_LOADER"

# The pack's own check, so a build that cannot prove itself fails here rather than in a job.
"$DIR/verify.sh" "$PACK_DIR"
log "built $PACK_DIR ($(du -sh "$PACK_DIR" | cut -f1))"
