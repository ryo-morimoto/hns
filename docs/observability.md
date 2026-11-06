# 観測

2026-11-06 / **実装済み（0028）**。要件17。

## 何を残すか

- `events` テーブル。すべての HTTP リクエスト（method・path・status・所要）、会話の開始と終了（`chat.submitted` / `chat.settled`）、中断、サーバ側の例外。
- クエリ文字列・ヘッダ・本文は残さない（token をログに落とさない）。
- 30日より古いイベントは起動時に削除する（`pruneEvents`）。

## API

| API | 返すもの |
| --- | --- |
| `GET /api/events?limit=&level=&since=` | 新しい順のイベント |
| `GET /api/metrics` | 24時間の HTTP 件数・status 別・p50/p95、chat 件数、Workflow / Firing の status 別、エラー数、今日の利用量 |

- 各レスポンスに `x-request-id` を返す。指定があれば引き継ぐ。
- 相関は `requestId` / `conversationId` / `runId` で追える。

## まだ無いもの

- メトリクスの時系列（今は直近24時間の集計のみ）。
- 外部への送出（OTLP・Prometheus）。
- ログの検索 UI（UI は最後）。
