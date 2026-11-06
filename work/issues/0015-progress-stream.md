# 0015: 進捗のストリーミングと未完了タスク

status: done
depends-on: 0014
touches: work/poc/app

## Goal

1秒ポーリングをやめ、会話と未完了タスクを流す。実行中に何が詰まっているか見える。

## Acceptance criteria

- [x] SSE で状態が流れる（接続直後に初期状態）
- [x] 実行中のタスクが UI に出る
- [x] 完了時にタスクが消える
- [x] 既存の E2E（再起動・続き）が通る

## Result

- `GET /api/stream` が `event: state` でスナップショットを送る。起点は Durable の `conversation.watch`（commit）で、30ms でまとめる。
- スナップショットは transcript・未完了タスク（`harness.inspect`）・キュー・scheduling。
- UI は EventSource に置換。タスクは「kind — state (#id)」で表示。
- `slow_tool`（1.5秒待つだけ）を足して、実行中の状態をテストで観測できるようにした。
- **12/12 合格**。
