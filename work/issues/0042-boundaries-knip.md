# 0042: 依存境界と未使用コードの検査

status: done
depends-on: 0031, 0046
touches: package.json, package-lock.json, packages/, docs/packages.md

## Goal

依存方向と未使用コードを機械的に検査する。

## Acceptance criteria

- [x] packages.md の依存辺を検査し、違反で落とす（oxlint の `no-restricted-imports`）
- [x] 未使用の export / 依存 / ファイルを検出する（knip）
- [x] CI と pre-commit に入れる（`npm run check` の末尾。CI は 0041 で低優先度）

## Notes

- 依存方向は `oxlint.config.ts` の `overrides`（0725db3）。独自チェッカーは持たない。
- knip 6.44.1 を exact pin。設定は `package.json` の `knip` に置き、`work/` と `tools/` を除外する。
  `packages/workspace/src/rooted-helper.ts` は exec されるプログラムなので entry に追加。
- knip が見つけて直したもの: agent の未使用 devDependency `@earendil-works/pi-env`、
  `CRASH_POINTS` / `HELPER_OPS` / `Settlement` の不要な export、未使用の `restoreParent`。

## やらないこと

- 独自の境界チェッカーを書かない（oxlint の既存ルールを使う）。
- knip の coverage / 自動 fix をゲートに入れない。

## Log

- 2026-11-07: 作成。依存方向は oxlint で導入済み。
- 2026-11-07: knip を導入し、0 issues まで整理。`npm run check` の末尾に `knip` を追加。

## Result

- `npm run check` = lint → fmt → tsc → test → build → `knip`。
- knip の設定: パッケージの export を entry とし、テストと rooted-helper を追加。`work/`・`tools/` は対象外。
- 直したもの: 未使用 devDep 1、不要 export 3、未使用 test helper 1。agent のテストが valibot を使うため devDependency に追加。
