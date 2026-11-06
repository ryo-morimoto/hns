# 利用量と制限

2026-11-06 / **実装済み（0027）**。要件15。

## 記録

- ターンが終わるたびに、Durable の `usage` の差分（トークン・コスト）を `usage_log` に1行残す。
- `GET /api/usage` がセッション合計（モデル別・ツール別）と今日の合計を返す。

## 制限（設定は `startApp` の `limits` か環境変数）

| 制限 | 設定 | 超えたとき |
| --- | --- | --- |
| レート | `turnsPerMinute` / `HNS_TURNS_PER_MINUTE` | 429（`retryAfterMs` 付き） |
| 1日のトークン | `dailyTokenBudget` / `HNS_DAILY_TOKEN_BUDGET` | 429（次のターンを開始しない） |
| 1ターンの時間 | `turnTimeoutMs` / `HNS_TURN_TIMEOUT_MS` | 会話を中断（`conversation.abort`） |

- レートは会話ごと、直近60秒の受け付けたターン数で数える。
- 予算は `usage_log` の当日合計で判定する。実行中のターンは止めない（次から止まる）。
- 中断は `POST /api/chat/abort`。実行中のターンだけ止める（`conversation.abort`）。
- 中断されたターンも、消費した分は `usage_log` に残る。
