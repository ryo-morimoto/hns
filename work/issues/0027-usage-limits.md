# 0027: 利用量と制限（要件15）

status: done
depends-on: 0014
touches: work/poc/app

## Goal

何にいくら使ったかを見えるようにし、暴走を止められるようにする。

## Acceptance criteria

- [x] ターンごとのトークン・コストを残す
- [x] セッションと当日の合計を返す API
- [x] レート制限（会話ごと・分あたり）
- [x] 1日のトークン予算
- [x] 1ターンのタイムアウトと明示的な中断

## Result

- `usage_log`、`/api/usage`、`/api/chat/abort`、`limits` 設定。
- 途中で気づいたこと: `abortSubmission` は実行中のターンを止めなかった。`conversation.abort` に変更（`already_placed` が返るだけ）。
- テスト `run-limits.mjs` 12/12。
