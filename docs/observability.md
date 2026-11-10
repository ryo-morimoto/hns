# 観測

2026-11-06 / **実装済み（0028）**。要件17。

## 何を残すか

- `events` テーブル。すべての HTTP リクエスト（method・path・status・所要）、会話の開始と終了（`chat.submitted` / `chat.settled`）、中断、サーバ側の例外。
- エージェントのターン（`agent.response`: provider/model・stopReason・トークン・コスト・エラー）。
- ツールの呼び出しと結果（`tool.call` / `tool.result`: 名前・callId・所要・isError・診断コード）。引数と出力の中身は残さない。
- クエリ文字列・ヘッダ・本文は残さない（token をログに落とさない）。
- 30日より古いイベントは起動時に削除する（`pruneEvents`）。

## イベントの種類

| 分類           | イベント                                                                                                                                                                            | 主な中身                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| サーバ         | `server.start`                                                                                                                                                                      | provider / model / auth / limits                     |
| 認証           | `auth.denied`                                                                                                                                                                       | mode                                                 |
| Project / Task | `project.created` `project.renamed` `task.created` `task.updated`                                                                                                                   | ID、状態                                             |
| 会話           | `conversation.created` `chat.submitted` `chat.settled` `chat.aborted`                                                                                                               | 状態、理由、所要                                     |
| エージェント   | `agent.response`                                                                                                                                                                    | provider/model、stopReason、トークン、コスト、エラー |
| ツール         | `tool.call` `tool.result`                                                                                                                                                           | 名前、callId、所要、isError、診断コード              |
| ファイル       | `file.write`                                                                                                                                                                        | path、applied / conflict / unknown                   |
| 秘密           | `secret.put` `secret.delete`                                                                                                                                                        | scope、name（値は残さない）                          |
| Workflow       | `workflow.created` `workflow.updated` `workflow.run.started` `workflow.run.finished` `workflow.run.failed` `workflow.node.started` `workflow.node.finished` `workflow.node.waiting` | runId、nodeId、type、状態、所要                      |
| Automation     | `automation.created` `automation.fired` `automation.skipped` `automation.finished`                                                                                                  | 起点、firing、run、状態                              |
| 制限           | `chat.rate_limited` `chat.budget_exceeded`                                                                                                                                          | 残り時間、当日トークン                               |
| HTTP           | `http` `http.error`                                                                                                                                                                 | method、path、status、所要                           |

引数・本文・出力の中身は残さない。値が要る分析は、そのとき別途取る。

## API

| API                                    | 返すもの                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/events?limit=&level=&since=` | 新しい順のイベント                                                                                                                                          |
| `GET /api/metrics`                     | 24時間の HTTP 件数・status 別・p50/p95、chat 件数、agent ターン数・ツール呼び出し数・ツールエラー数、Workflow / Firing の status 別、エラー数、今日の利用量 |

- 各レスポンスに `x-request-id` を返す。指定があれば引き継ぐ。
- 相関は `requestId` / `conversationId` / `runId` で追える。

## まだ無いもの

- メトリクスの時系列（今は直近24時間の集計のみ）。
- 外部への送出（OTLP・Prometheus）。
- ログの検索 UI（UI は最後）。
