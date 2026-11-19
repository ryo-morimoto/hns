# e2e

0239 の Phase 0 の journey（Playwright）。**この package はルートの workspace ではない**: 依存を
`npm run check` と knip に漏らさないため、`e2e/` に閉じた package として持つ。

## 何を見るか

**人が開いて読めるか**を見る。3 形式が `ready` になり、1 ページ目が描かれ、2 回目はキャッシュで、
監査に `office.job` が 1 本出て、キーボードで操作でき、workspace の外のパスは拒否される。
**配線の順序**（どの層がどの object を引くか、ポーリングが何を待つか）はここでは見ない——
`packages/server/test/integration/office-workspace-id.test.ts`、
`packages/server/test/integration/office-alarm.test.ts`、
`packages/web/src/office/DocumentPanel.test.tsx` の責務。理由と分担は
[docs/procedures/testing.md](../../docs/procedures/testing.md)。

**object の dispatch はこの harness のもの**（1 名前 1 インスタンス・SQLite の state・alarm の
発火）。workerd ではない。何を試して何で止まったかは `e2e/support/runtime.ts` の冒頭に書いてある。

## 走らせる（2026-11-19 にこの開発機で実際に通した手順）

worktree で。`nix develop` は使っていない（system の node 24）。

```bash
# 1. ブラウザ。PLAYWRIGHT_BROWSERS_PATH を固定すると、後で同じ場所を指せる。
cd e2e
PLAYWRIGHT_BROWSERS_PATH=$PWD/../.cache/ms-playwright npx playwright install chromium

# 2. pack（556 MB）。**main の実体をリンクする**（worktree で 2 回目を作らない）。
#    machine は pack を bwrap で ro bind するので、リンクでもよい（runtime 側で realpath する）。
#    <main checkout> は main の worktree の絶対パス。
ln -sfn <main checkout>/office-pack ../office-pack
#    自前で作るなら（1 checkout で 1 回だけ。build.sh は .cache/office-pack を共有する）:
#    ../tools/office-pack/build.sh
#    （build.sh は <repo>/office-pack を作るので、worktree で走らせるなら
#     IBIS_OFFICE_PACK_DIR=$PWD/../office-pack も付ける。）

# 3. Chromium の共有ライブラリを LD_LIBRARY_PATH に並べる。
#    nix store には **32bit の同名ライブラリが先に並ぶ**ので、`wrong ELF class: ELFCLASS32` で
#    Chromium が落ちる。名前だけで選ばず、**ELF の 64bit ヘッダを確かめてから**選ぶ:
mkdir -p ../.cache/e2e-libs
for n in libglib-2.0.so.0 libnss3.so libnspr4.so libexpat.so.1 libcairo.so.2 \
         libpango-1.0.so.0 libharfbuzz.so.0 libfreetype.so.6 libfontconfig.so.1 \
         libdbus-1.so.3 libatk-1.0.so.0 libatk-bridge-2.0.so.0 libcups.so.2 \
         libasound.so.2 libgbm.so.1 libdrm.so.2 libX11.so.6 libXcomposite.so.1 \
         libXdamage.so.1 libXext.so.6 libXfixes.so.3 libXrandr.so.2 libXrender.so.1 \
         libxcb.so.1 libxkbcommon.so.0 libxshmfence.so.1; do
  while read -r p; do
    if [ "$(od -An -tx1 -N5 "$p" | tr -d ' \n')" = 7f454c4602 ]; then dirname "$p"; break; fi
  done < <(find /nix/store -maxdepth 3 -name "$n" 2>/dev/null | head -60)
done | paste -sd: > ../.cache/e2e-libs/ld-library-path.txt

# 4. 走らせる
export LD_LIBRARY_PATH=$(cat ../.cache/e2e-libs/ld-library-path.txt)
export PLAYWRIGHT_BROWSERS_PATH=$PWD/../.cache/ms-playwright
npx playwright test          # 1 passed（約 13 秒）
```

**ブラウザの版の差が 1 つある。** Playwright が入れる Chromium 145 には `Math.sumPrecise` が無く、
`pdfjs-dist` 6.5.438 は注釈エディタの経路でそれを使う。journey は `page.addInitScript` で
仕様どおりの和（Neumaier）を入れてから開く——**ビューアはこの API を使わない**ので、見ているのは
このビルドのビューアであってブラウザの年齢ではない。

## 計測（C6）

150 ページの docx を N 回、**毎回コールドの cache** で変換し、中央値と p95 を出す。数字は機械の
office job の `stats.ms`（同じ値が `office.job` の監査行に乗る）。

```bash
node --experimental-strip-types ./tools/c6.ts 10
```

**2026-11-19 の結果（この開発機）**: N=10、中央値 **342 ms**、p95 **347 ms**、初回 **338 ms**
（150 ページ、毎回コールド cache、`ibisOffice 0.8.7`、nix develop なしの node 24、
CPU 16 コア / 他のレーンと同時実行なしの単発計測）。要件の初回 3 秒 / p95 5 秒に対して余裕がある。
