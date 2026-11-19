# e2e

0239 の Phase 0 の journey（Playwright）。**この package はルートの workspace ではない**: 依存を
`npm run check` と knip に漏らさないため、`e2e/` に閉じた package として持つ。

## 何を見るか

**人が開いて読めるか**を見る。3 形式が `ready` になり、1 ページ目が描かれ、2 回目はキャッシュで、
監査に `office.job` が 1 本出て、キーボードで操作でき、workspace の外のパスは拒否される。
**配線の順序**（どの層がどの object を引くか、ポーリングが何を待つか）はここでは見ない——
`packages/server/test/integration/office-alarm.test.ts` と
`packages/web/src/office/DocumentPanel.test.tsx` の責務で、E2E はその退行を検出しない。
理由と分担は [docs/procedures/testing.md](../../docs/procedures/testing.md)。

## 走らせる（この開発機）

**CI には繋いでいない**（実 pack 556 MB・実 machine・nix store の lib が要り、CI への持ち込みは
CI 基盤の issue の仕事）。ここは開発機で回す手順だけを書く。

```bash
# 1. ブラウザ（初回だけ）。PLAYWRIGHT_BROWSERS_PATH で置き場を固定できる。
cd e2e
PLAYWRIGHT_BROWSERS_PATH=$PWD/../.cache/ms-playwright npx playwright install chromium

# 2. pack（無ければ build.sh が作る。1 checkout で 1 回だけ走らせる）
HNS_E2E_BUILD_PACK=1 ../tools/office-pack/build.sh

# 3. Chromium の共有ライブラリ。このホストの /nix/store から 64bit のものを選び、
#    LD_LIBRARY_PATH に並べる（32bit の同名ライブラリが先に見つかると wrong ELF class で落ちる）。
#    必要な名前: glib-2.0 / nss3 / nspr4 / expat / cairo / pango / harfbuzz / freetype /
#    fontconfig / dbus-1 / atk-1.0 / atk-bridge-2.0 / cups / asound / gbm / drm / X11 /
#    Xcomposite / Xdamage / Xext / Xfixes / Xrandr / Xrender / xcb / xkbcommon / xshmfence
export LD_LIBRARY_PATH=$(bash ../.cache/e2e-libs/find.sh)   # 下の「ライブラリの探し方」

# 4. 走らせる
export PLAYWRIGHT_BROWSERS_PATH=$PWD/../.cache/ms-playwright
npx playwright test
```

### ライブラリの探し方（`LD_LIBRARY_PATH`）

nix store には 32bit の同名ライブラリが先に並ぶ。名前だけで選ぶと Chromium が
`wrong ELF class: ELFCLASS32` で落ちるので、**ELF の 64bit ヘッダを確かめてから**選ぶ:

```bash
for n in libglib-2.0.so.0 libnss3.so libnspr4.so libexpat.so.1 libxcb.so.1 libgbm.so.1; do
  while read -r p; do
    if [ "$(od -An -tx1 -N5 "$p" | tr -d ' \n')" = 7f454c4602 ]; then dirname "$p"; break; fi
  done < <(find /nix/store -maxdepth 3 -name "$n" 2>/dev/null | head -60)
done | paste -sd:
```

## 計測（C6）

150 ページの docx を N 回、**毎回コールドの cache** で変換し、中央値と p95 を出す。数字は機械の
office job の `stats.ms`（同じ値が `office.job` の監査行に乗る）。

```bash
node --experimental-strip-types e2e/tools/c6.ts 10
```

**2026-11-19 の結果（この開発機）**: N=10、中央値 **342 ms**、p95 **347 ms**、初回 **338 ms**
（150 ページ、毎回コールド cache、`ibisOffice 0.8.7`、nix develop なしの node 24、
CPU 16 コア / 他のレーンと同時実行なしの単発計測）。要件の初回 3 秒 / p95 5 秒に対して余裕がある。
