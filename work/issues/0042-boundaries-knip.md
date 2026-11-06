# 0042: 依存境界と未使用コードの検査

status: open
depends-on: 0031
touches: packages/, scripts

## Goal

依存方向と未使用コードを機械的に検査する。

## Acceptance criteria

- [ ] packages.md の依存辺を検査し、違反で落とす
- [ ] 未使用の export / 依存 / ファイルを検出する
- [ ] CI と pre-commit に入れる
