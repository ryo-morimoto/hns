# 0051: 並列ブランチのルールと前提の整理

status: done
depends-on: -
touches: work/README.md, work/BOARD.md, work/issues/*（新規の雛形）

## Goal

1 issue = 1 ブランチで並列に進めても壊れないよう、触る場所・前提・順序・やらないことを issue と BOARD に固定する。

## Acceptance criteria

- [x] issue の必須項目を決める: status / depends-on / touches / やらないこと
- [x] 同じパッケージを触る issue は直列、別パッケージなら並列可、を BOARD に明記する
- [x] `package.json` / `package-lock.json` を触る issue は同時に1つ（lock owner）
- [x] マージ順と、マージ前に `npm run check` を必須にする
- [x] 依存 issue が未マージのブランチでは、依存先のファイルを触らない
- [x] BOARD に「並列グループ」列（または節）を足す

## Notes

- 並列可の例: store（0047 / 0048）と agent（0049）と core（0050）は別パッケージ。
- 直列の例: 0035 と 0038 / 0039 は packages/server が重なるので、依存順に積む。
- ブランチ名は `issue/NNNN-slug`。

## やらないこと

- CI の実装（0041）と branch protection（リモート設定）。

## Log

- 2026-11-07: 作成。
- 2026-11-07: `work/README.md` に issue 形式（`やらないこと` を含む）と並列ルールを、`work/BOARD.md` に「並列の単位」と新しい順序を追加。

## Result

- 1 issue = 1 ブランチ、`touches` は契約、`depends-on` は未マージなら着手しない。
- `package.json` / `package-lock.json` は同時に1 issue だけ触る（lock owner）。
- 同じパッケージは直列、別パッケージは並列可。BOARD の「並列の単位」が現在の組み合わせ。
- マージ前に main へ rebase して `npm run check`。ついでの変更と先回りを禁止。
