# 利用量と制限

2026-11-06 / **実装済み（0027）**。要件15。

## 記録

- ターンが終わるたびに、Durable の `usage` の差分（トークン・コスト）を `usage_log` に1行残す。
- `GET /api/usage` がセッション合計（モデル別・ツール別）と今日の合計を返す。

## 制限（設定は `startApp` の `limits` か環境変数）

| 制限          | 設定                                          | 超えたとき                         |
| ------------- | --------------------------------------------- | ---------------------------------- |
| レート        | `turnsPerMinute` / `HNS_TURNS_PER_MINUTE`     | 429（`retryAfterMs` 付き）         |
| 1日のトークン | `dailyTokenBudget` / `HNS_DAILY_TOKEN_BUDGET` | 429（次のターンを開始しない）      |
| 1ターンの時間 | `turnTimeoutMs` / `HNS_TURN_TIMEOUT_MS`       | 会話を中断（`conversation.abort`） |

- レートは会話ごと、直近60秒の受け付けたターン数で数える。
- 予算は `usage_log` の当日合計で判定する。実行中のターンは止めない（次から止まる）。
- 中断は `POST /api/chat/abort`。実行中のターンだけ止める（`conversation.abort`）。
- 中断されたターンも、消費した分は `usage_log` に残る。

## 月次の運用上限（プラットフォーム・provider）

2026-11-17 / D049 / 実装 [packages/server/src/cost/](../packages/server/src/cost/) / 運用 [deploy/limits/README.md](../deploy/limits/README.md)。
上の 0027 の制限（PoC のターン単位）とは別の層で、**月の費用を有界にする**ための上限。Cloudflare 経路（0157 以降）の
Durable Object と R2 は、金額ではなく**行数とリクエスト数**で効く（[durability.md](durability.md) §7）。

| 面 | 上限の置き場 | 数え方 | 超えたとき |
| --- | --- | --- | --- |
| DO 行 | `cost_limits.do_rows_limit`（migration 3） | `cost_turn.do_rows` の当月 SUM | 新しい Run を 429 `limit_exceeded` |
| DO リクエスト | `cost_limits.do_requests_limit` | `cost_turn.do_requests` の当月 SUM | 同上 |
| R2 オブジェクト | `cost_limits.r2_objects_limit` | `cost_turn.r2_objects` の当月 SUM | 同上 |
| provider（USD） | `provider_gateway.month_limit`（0151） | 同じ行の `month_spent`（当月キーのとき） | 同上（gateway の 429 と二段） |

- **記録**: 1 ターン = `cost_turn` の 1 行（`id` は送信の requestId。再送は同じ行で、二重計上しない）。行は D1
  （確定した記録は D1、実行中の状態は DO = D049）。月次は列の集計で、カウンタ行を持たない。
- **計上**: 失敗したターンも 1 行（行はもう書かれている）。`outcome` は `completed` / `failed` の 2 値で、
  上限判定はどちらも合計する。abort は別値にしない（settlement の理由は自由文で、閉じた語彙ではない）。
- **アラート**: `warn_ratio` / `critical_ratio`（既定 0.5 / 0.8）を跨いだターンで、`cost: alert <metric> <level> <used> <limit>`
  の 1 行を出す。跨ぎは「記録後の合計 − そのターン」で判定するので状態を持たない。
- **縮退**: 新しい Run だけを止める。`/rpc/conversations/:id/messages` の `session.send` の前で判定し、
  既存 Run の abort・transcript・一覧は変えない。上限・当月合計・provider 行が読めないときは
  503 `limit_unavailable`（fail closed）。
- **値**: コードに直書きしない。`cost_limits` の seed（無料枠の桁）を運用の `UPDATE` で変える。既定値・手順・
  アラートの受け取り方は [deploy/limits/README.md](../deploy/limits/README.md)。
- **実測**: 1 ターンの行・リクエスト・R2 の実測と月 1 万ターンへの外挿は [RESULTS](../deploy/limits/RESULTS.md)。
