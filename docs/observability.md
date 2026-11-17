# 観測

2026-11-06 / **実装済み（0028）**。要件17。
2026-11-17 / 0162 で相関 ID を全ホップに通し、ログの形を core の1型にした（D082 で 0039 を吸収）。

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
| DO             | `do.rpc`                                                                                                                                                                           | path、status、所要（会話 RPC は agent のイベントで表す） |
| ファイル (machine) | `fs.op`                                                                                                                                                                       | op（read/stat/list/health）、path、status、所要     |

引数・本文・出力の中身は残さない。値が要る分析は、そのとき別途取る。

## 相関 ID とホップ

1つのリクエストを `x-request-id` 1つで追う。新しい ID を作るのは edge だけで、下流は受信値をそのまま使う。

| ホップ | 何が記録するか | どこから ID を受けるか |
| --- | --- | --- |
| browser | クライアントが `x-request-id` を送る（任意） | 自分で発番した値 |
| worker | `http` / `http.error`（pathname・status・所要） | inbound ヘッダ。不正なら UUID を生成（0145） |
| do | `do.rpc`（内部 RPC。ターンは agent のイベント） | edge が転送するヘッダ |
| agent | `agent.response` / `tool.call` / `tool.result` | Session RPC のヘッダ（body の `requestId` が優先） |
| fs | `fs.op`（machine の read/stat/list/health） | Worker → machine のヘッダ |

- `x-request-id` は**署名対象でも認証材料でもない**。0147 の署名は machineId / connection / seq /
  timestamp / nonce / method / path / bodyHash だけを覆い、相関 ID を改ざんしても拒否理由にならない。
- 相関は `requestId` / `conversationId` / `runId` で追える。

## ログの形

server（Durable Object）と machine は同じ `ObsLogEntry`（`@hns/core`）を書く。

```json
{"v":1,"at":"2026-11-17T12:00:00.000Z","level":"info","event":"http","hop":"worker","requestId":"req-1","path":"/graphql","status":200,"durationMs":4,"detail":{"tool":"POST"}}
```

- フィールドは `v` / `at` / `level` / `event` / `hop` / `requestId` / `path` / `status` /
  `durationMs` / `detail` だけ。語彙は core の const array + 閉じた union（`OBS_HOPS`、
  `EVENT_NAMES`、`EVENT_LEVELS`、`OBS_DETAIL_KEYS`）。
- `path` は pathname だけ。クエリ・フラグメントは落とし、長さは 512 文字で切る。
- `detail` は allowlist のキーだけ（`tool` / `op` / `ok` / `code` / `conversationId` / `runId` /
  `bytes`）。本文・ヘッダ・トークン・鍵は型にも allowlist にも無く、`formatObsLog` は既知のキーだけを書く。
  agent の応答 text はログに残さない。
- 未知の hop / event / level を持つ行は `ValiError` で落ちる（既定値に落とさない）。

## 保管

- イベントは **Session Durable Object の SQLite**（`obs_events` 表）に置き、D1 に複製しない（D049 / D053）。
- 保持は **30 日**、件数は **5000 件**（ワークスペースあたり）。append 時に上限を超えた分を1文で消し、
  保持の削除は 256 回の append ごとに1回だけ回す。
- API の `limit` は 1..500。古い行は起動時と上の間隔で消える。
- 会話 RPC（`/rpc/conversations/...`）は `do.rpc` を別に書かない。ターンの DO ホップは
  `agent.response`（同じ requestId）で表し、1ホップを二重に数えない。

## API

| API                                              | 返すもの                                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/events?limit=&level=&since=&requestId=` | 新しい順のイベント                                                                                                                                          |
| `GET /api/metrics`                               | 24時間の HTTP 件数・status 別・p50/p95、hop 別件数、エラー数、agent ターン数・ツール呼び出し数・ツールエラー数、イベント名別、保存件数と保持設定 |

- 認証は session cookie。未認証は 401、GET 以外は 405、`SESSION` binding が無い場合は 503、
  query が不正なら 400。応答は `{ ok: true, events }` / `{ ok: true, metrics }` で `cache-control: no-store`。
- 各レスポンスに `x-request-id` を返す。受信値が `[A-Za-z0-9._:-]{1,128}` に合えば引き継ぎ、
  不正なら生成する（0145 の境界で検査）。
- イベントの読み出しは edge が Session DO の内部 RPC（`/rpc/events` / `/rpc/metrics`）へ転送する。
  DO は公開しない。

## どこで詰まったかを1コマンドで見る

```bash
HNS_URL=http://127.0.0.1:8787 HNS_SESSION_COOKIE='hns_session=...' \
  node tools/obs/trace.mjs <requestId> [--expect fs]
```

- 環境変数は `HNS_URL` と `HNS_SESSION_COOKIE`。`/api/events?requestId=...` を読む。
- hop ごとに event / path / status / 所要 / conversationId / runId を時系列で出し、最後に
  `reached` と `stopped after`（到達した最も深い hop）と `not observed` を出す。
- `--expect <hop>` を付けると、その hop に届いていないとき exit 1（「どこで詰まったか」を機械可読にする）。
  到達していれば exit 0。引数不足・接続不能・401 は exit 2。

## まだ無いもの

- メトリクスの時系列（今は直近24時間の集計のみ）。
- 外部への送出（OTLP・Prometheus）。
- ログの検索 UI（UI は最後）。
- Workflow / Firing / 利用量のメトリクス（それぞれの record を持つ issue が足す）。
- machine から Worker へのログ送出（0162 は machine の受信ログを固定する。送出は 0148 / 0157）。
