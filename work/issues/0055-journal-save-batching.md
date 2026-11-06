# 0055: Journal の保存を write 単位でまとめる

status: open
depends-on: 0045
touches: packages/workspace

## Goal

1 回の write で journal を最大 3 回（intent / outcome / event）保存している。0045 で
temp + flush + rename の原子的保存にしたため 1 回あたりの fs op も増えた。回数を減らす。

## Acceptance criteria

- [ ] write 1 回あたりの保存回数と fs op を計測し、issue に残す
- [ ] outcome と event を 1 回の保存にまとめる（intent は先行して残す必要がある）
- [ ] 既存の回帰テスト（並行 write / conflict / crash）が通る
- [ ] churn テストを含めて、全体実行が安定することを確認する

## Notes

- 0046 で churn テストは決定的になった。ここは性能と競合の余地として残す。
- 「計測してから」を前提にする。速さが問題になっていないなら close してよい。
- packages/workspace を触るので 0053 / 0054 と直列。

## やらないこと

- Journal の形式変更（追記専用ログへの移行は必要になってから）。
- 保存の非同期化・バックグラウンド化。

## Log

- 2026-11-07: 作成（0045 の原子的保存の副作用として）。
