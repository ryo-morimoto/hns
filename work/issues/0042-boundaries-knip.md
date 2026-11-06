# 0042: 依存境界と未使用コードの検査

status: open
depends-on: 0031, 0046
touches: packages/, scripts

## Goal

依存方向と未使用コードを機械的に検査する。

## Acceptance criteria

- [ ] packages.md の依存辺を検査し、違反で落とす
- [ ] 未使用の export / 依存 / ファイルを検出する
- [ ] CI と pre-commit に入れる

## Notes

- 依存方向は `oxlint.config.ts` の `no-restricted-imports` で導入済み（0725db3）。
- 残りは knip。`package.json` / `package-lock.json` を触るので、0048 と 0035 の依存追加より前に済ませる。
- 0046 の後（テストランナーの決定が package.json を動かすため）。

## やらないこと

- 独自の境界チェッカーを書かない（oxlint の既存ルールを使う）。
