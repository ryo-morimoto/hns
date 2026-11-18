# 観測

2026-11-06 / **実装済み（0028）**。要件17。
2026-11-17 / 0162 で相関 ID を全ホップに通し、ログの形を core の1型にした（D082 で 0039 を吸収）。

## 何を残すか

- `obs_events` 表（Session Durable Object の SQLite。D1 の `events` 表は migration 6 で廃止した）。すべての HTTP リクエスト（method・path・status・所要）、会話の開始と終了（`chat.submitted` / `chat.settled`）、中断、サーバ側の例外。
- エージェントのターン（`agent.response`: provider/model・stopReason・トークン・コスト・エラー）。
- ツールの呼び出しと結果（`tool.call` / `tool.result`: 名前・callId・所要・isError・診断コード）。引数と出力の中身は残さない。
- クエリ文字列・ヘッダ・本文は残さない（token をログに落とさない）。
- 30日より古いイベントは起動時に削除する（`ObsStore.prune`）。

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
| 索引           | `index.rebuilt` `index.drain.failed` `index.state.failed` `index.legacy_rows`                                                                                                    | 索引した/消した件数、試行回数、コード                 |
| HTTP           | `http` `http.error`                                                                                                                                                                 | method、path、status、所要                           |
| DO             | `do.rpc`                                                                                                                                                                           | path、status、所要（会話 RPC は agent のイベントで表す） |
| ファイル (machine) | `fs.op`                                                                                                                                                                       | op（read/stat/list/health）、path、status、所要     |

引数・本文・出力の中身は残さない。値が要る分析は、そのとき別途取る。

## 相関 ID とホップ

1つのリクエストを `x-request-id` 1つで追う。HTTP の相関 ID を発番するのは edge で、下流は受信値をそのまま使う。
edge を通らない内部呼び出し（agent の `send` / `openAgent` など）は、呼び出し側が ID を渡さない場合に
自分の turn ID を生成することがある。その場合は edge の HTTP ID と相関しない。

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

### 観測外の欠陥ログ（console.error）

観測ログに載せられない失敗だけが `console.error` で出る。**すべて「欠陥」**（起きたこと自体がバグか、観測の
書き込みそのものが壊れた場合）で、リクエストの追跡対象にはならない。理由は次のどれか。

- 観測の書き込み自体が失敗した（`session obs open failed` / `session obs append failed` / `edge: event write failed` /
  `edge: response log failed`）。ログに書きにいって落ちたものをそのログに書けない。
- Session が開けない・alarm が動かない（`session open failed` / `session alarm failed` / `session wake arm failed`）。
  この場合そのオブジェクトの観測行は存在しない。
- 想定外の例外（`edge: unhandled request` / `graphql: request failed` / `session rpc failed` / `workspace rpc failed` /
  `session reindex failed`）。応答の 500 は `http.error` / `do.rpc` として観測に出る。ここで出るのは原因の名前だけで、
  stack とメッセージは出さない（行データを含み得る）。
- 外部設定・外部呼び出しの失敗（`gateway: <stage>` / `cost: <stage> failed`）。応答はコード付きの失敗として観測に
  出るため、これは原因の名前だけを残す 2 本目の線。

### 索引の観測（`index.*`）と測定窓

形・保持・測定窓の**契約は [contracts/observability.md](contracts/observability.md)**。ここは手順だけ。

索引の `index.*` も observation で、`indexEntry`（`packages/server/src/obs/log.ts`）が組み立てた
`ObsLogEntry` を、`Session` が同じ `obs_events` 表へ append する（`SessionIndex` の sink は
`(entry: ObsLogEntry) => void`、既定の sink は console への 1 行）。

- **測定窓**は「そのターンが書いた行」まで。`CostGate.turn` はターンの行を**測ってから**
  `turnEnded` を呼び、索引の drain とその観測はそこ（窓の外）で書く。だから観測が増えても
  `cost_turn.do_rows` は増えない（`session-cost.test.ts` の 10 行が同じ）。
- **失敗時は観測を落とす**。drain が D1 で失敗したとき、`index_state` の状態行（`d1_write_failed`）だけを
  書き、`index.drain.failed` の行は append しない。D1 障害のたびに 1 行増えると、障害が課金の測定を汚す。
- 成功した drain の `index.legacy_rows` / `index.rebuilt` は窓の外で 1 行だけ書く。drain は先に索引を
  読んで変更の無い行を書かないので、通常のターンでは行も D1 の書き込みも増えない。

### ミラーの観測（`artifacts.mirror`）と kill switch

形の契約は [contracts/observability.md](contracts/observability.md)。ここは手順だけ。

- **kill switch は 1 つの判定**（`packages/server/src/artifacts/kill-switch.ts`）。**env 既定 + workspace override**（`POST /rpc/checkpoint/switch` で `on` / `off` / `null`）。off は
  **prepare が target を出さないだけ**で、checkpoint は成功し、run の mirror 状態は `pending` のまま残る（データを失わない）。戻せば次の prepare が拾う。switch は prepare のたびに読むので、object を再構成せずに止まる。
- Workspace Object は、ミラーの結果を記録したときに `artifacts.mirror` を 1 行書く（`artifacts/observability.ts`）。書く先は edge が渡す sink（`observe`）。sink が無ければ console だけ。
- `GET /api/metrics` の `metrics.mirror` は **p95・失敗率・skip 率・repo 数**を 24 時間の窓で出す。行は Session DO の `obs_events` から読み、token も remote も出さない。
- **ローカルシミュレータは cf dev**（`packages/server/test/integration/artifacts-local.test.ts`）。wrangler 4.156.0（cf 1.0.0-beta.28）は Artifacts のローカルシミュレータを持たない（binding 表で "will never have a local simulator"、`remote: false` でも Mode は remote）。CI は Cloudflare アカウントを使わない。

## 失敗コードと status

サーバの面（edge・gateway・files・Session RPC・Workspace RPC）は、予期した失敗を閉じたコードで返す。
**code → status の表は `packages/server/src/failures/status.ts` の 1 か所だけ**で、各面は自分が返すコードの
部分集合を型で宣言して表から引く（面のコードから数値の引数は消えた）。ここは表の読み方だけを書く。

| code | status | transport | 返す面 |
| --- | --- | --- | --- |
| `unauthorized` | 401 | http | edge |
| `invalid_request` | 400 | http | edge / files / session-rpc / workspace-rpc |
| `forbidden` | — | graphql | GraphQL の MutationFailure のみ（union のメンバー） |
| `not_found` | 404 | http | edge / gateway / files / session-rpc / workspace-rpc |
| `method_not_allowed` | 405 | http | edge / gateway / session-rpc / workspace-rpc |
| `conflict` | 409 | http | files / workspace-rpc |
| `denied` | 400 | http | files / workspace-rpc（machine が書く前に断った） |
| `payload_too_large` | 413 | http | edge / gateway / files / session-rpc / workspace-rpc |
| `unsupported_media_type` | 415 | http | edge / gateway / files / session-rpc / workspace-rpc |
| `upgrade_required` | 426 | http | edge |
| `not_implemented` | 501 | http | edge |
| `budget_exceeded` | 429 | http | gateway |
| `limit_exceeded` | 429 | http | session-rpc（月次上限）。GraphQL は union のメンバー |
| `limit_unavailable` | 503 | http | session-rpc |
| `stopped` | 503 | http | gateway |
| `unavailable` | 503 | http | edge / gateway / files / session-rpc / workspace-rpc / GraphQL |
| `timeout` | 504 | http | edge |
| `upstream` | 502 | http | gateway |
| `internal` | 500 | http | edge / files / session-rpc / workspace-rpc |
| `lease_not_held` / `lease_expired` / `lease_epoch_stale` | 409 | http | files / workspace-rpc |
| machine 独自（`stale_request` / `replayed` / `stale_connection` / `path_denied` / `busy` / `deadline_exceeded`） | `refusal.ts` の部分集合 | http | machine（server は返さない） |

- **status 列が `—` の行は transport が `graphql`**。GraphQL の失敗は HTTP status を持たず、結果 union の
  メンバーとして 200 のエンベロープに入る。表の型も status と transport を組で持つので、status の無い行に
  `http` を書くとコンパイルエラーになる。
- `invalid_request` は REST（400、HTTP 要求が不正）と GraphQL（`INVALID_REQUEST`、フィールドの引数が不正）で
  **同じ綴り・同じ status、意味は別**。面ごとのコード集合は閉じたまま分けている。
- `method_not_allowed` は method の不一致（405）。base では `invalid_request` の別 status として 405 を渡していたが、
  code で表すようにした（status は不変）。body 拒否は `payload_too_large`（413）と
  `unsupported_media_type`（415）で、これも code が status を決める。
- **綴りは 1 つ**。GraphQL の `QueryFailureCode` / `MutationFailureCode` も REST と同じ `invalid_request`（enum は
  `INVALID_REQUEST`）を使う。GraphQL 専用の `forbidden` は union のメンバーだけ。
- machine は server を import できない（依存は server → machine）。machine の `refusal.ts` が同じ code の部分集合を
  宣言し、値は `packages/machine/src/refusal.test.ts` が修正前の switch の値と 1:1 で固定している。上表の
  `unauthorized` / `invalid_request` / `forbidden` / `not_found` / `method_not_allowed` / `internal` は machine も返し、
  machine の `too_large` は server の `payload_too_large`（413）と同じ綴り違いのペア。
- files 面の `unknown`（machine が適用したか決められない保存）だけは表の行が無く、面の中で 504 を 1 回書く。

## 保管

- イベントは **Session Durable Object の SQLite**（`obs_events` 表）に置き、D1 に複製しない（D049 / D053）。
- 保持は **30 日**、件数は **5000 件**（ワークスペースあたり）。append 時に上限を超えた分を1文で消し、
  保持の削除は 256 回の append ごとに1回だけ回す。
- API の `limit` は 1..500。古い行は起動時と上の間隔で消える。
- 会話の送信 RPC は、**成功して agent イベントを書いたときだけ** `do.rpc` を省略する
  （ターンの DO ホップは `agent.response` が同じ requestId で表す）。失敗したターン（400 / 429 / 503）は
  agent イベントが無いので `do.rpc` を残し、trace が worker で止まらないようにする。
- edge の `http` イベントは応答後に fire-and-forget で送る。`waitUntil` には乗せていないため、応答直後に
  isolate が終了すると行が失われ得る。`/api/metrics` の件数と p50/p95 は**下限**として読む。

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
  trace 自身の要求は `x-request-id` を送らない（自分の ID でログを汚さない）。
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
