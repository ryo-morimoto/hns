# @hns/server

Worker の入口と Session / Workspace Durable Object。公開する面を GraphQL / WS / 静的の3つに絞り、
境界でセッション cookie・相関 ID・上限を扱う。会話と run は Session DO が持つ。

## Edge

- `src/edge/worker.ts` — 本番の組み立て。`/graphql` は GraphQL face、`/ws` は Session DO へ転送する。
- `src/edge/handler.ts` — `createEdge(deps, limits)`。ルーティング、認証、相関 ID、時間制限。
- `src/edge/session.ts` — `hns_session` の署名・検証。値は `<base64url(payload)>.<base64url(HMAC-SHA256(payload))>`。
- `src/edge/correlation.ts` — `x-request-id`。受信値は形式を検査して引き継ぎ、不正なら生成する。
- `src/edge/body.ts` — JSON body の上限付き読み取り。`Content-Length` とストリームの両方で数える。
- `src/edge/limits.ts` — 1 MiB / 10 秒 / 500 行（1リクエスト）/ 100 行（1リスト）と `RowBudget`。
- `src/edge/problem.ts` — `application/problem+json` と閉じた `code` union。
- `src/edge/env.ts` — edge が使う Cloudflare バインディングの最小構造型。

## 面

| パス                           | メソッド       | 認証              | 動作                                                    |
| ------------------------------ | -------------- | ----------------- | ------------------------------------------------------- |
| `/graphql`                     | `POST`         | セッション cookie | 0145 では 501。schema / resolver は 0176                |
| `/ws`                          | `GET`          | セッション cookie | Session DO へ転送。ライブ frame は core の `LiveFrame`  |
| `/api/events` / `/api/metrics` | `GET`          | セッション cookie | Session DO の観測面（0162）                             |
| `/api/workspaces/:id/files`    | `GET` / `POST` | セッション cookie | Workspace DO の版付き読み書き（`src/files/content.ts`） |
| それ以外                       | `GET` / `HEAD` | 不要              | `ASSETS` へ委譲。配信設定は 0160                        |
| その他の `/api/*`              | すべて         | —                 | 404                                                     |

`OPTIONS` は 405 で、CORS ヘッダは返さない。デバッグ用の口は作らない。
`ASSETS` の `notFoundHandling` は SPA fallback にしない（画面は hash router）。未知のパスを 200 にしない設定は 0160 が持つ。

## セッション

- cookie 名は `hns_session`。payload は `{v:1,sub,exp}`（`exp` は秒）。
- `HNS_SESSION_SECRET`（32文字以上）で HMAC-SHA256 を検証する。未設定・短い・期限切れ・改ざん・重複は 401。
- `Set-Cookie` の属性（`Secure` / `HttpOnly` / `SameSite=Lax` / 30日）は 0158 が付ける。

## Session Durable Object

- `src/do/session.ts` — 1 ワークスペースに 1 つの `Session`。plain class（`DurableObject` を継承しない）で、
  `constructor(state, env)` / `fetch` / `alarm` を持つ。
- `openDurableObjectSqliteStorage(ctx.storage, { prefix: "hns_session" })` で Harness を開く。
- `onWake` → DO alarm → `resume()`。active 中は 60 秒の heartbeat、idle なら alarm を消す。
  `HarnessOptions.setTimer` は渡さない。durable wakeup は alarm だけ。
- `src/do/session-rpc.ts` — 内部 RPC。create / list / get / transcript / messages / abort。
  edge には公開しない。0176 の resolver が binding から呼ぶ。
- `src/do/models.ts` — 0146 は development の `faux/<id>` だけ。staging / production は 503（0152 まで）。
- `src/ws.ts` — ライブ face。`WebSocketPair` を `acceptWebSocket` し、conversation ごとに
  snapshot → append / 間引いた delta を送る。購読は socket attachment に残すので hibernation を越える。
- `src/do/alarm.ts` — `armWake`。idempotent で、二重 alarm でも run を二重に作らない。
- 会話の title / project / timestamps は session document（`hns.conversation.index`）に残る。
  pi-durable の conversation record は transcript と ID を持ち、一覧は `scanConversations` で引く。

## Workspace Durable Object

- `src/do/workspace.ts` — 1 ワークスペースに 1 つの `Workspace`。lease（epoch は発行のたびに増える）、
  `path → 版` の表（machine が最後に報告した版のキャッシュ）、Journal を持つ。ファイルの書き込みは
  intent（Journal）→ machine（適用）→ outcome の順で、ack は outcome の記録後。版の比較は machine が再計算して行う。
- `src/do/machine.ts` — machine への port（`write` / `read`）と、control-plane 鍵で署名する実装。
  machine の id は呼び出しごと（write は lease の保持者、read は lease 取得時に残した machine）。
- `src/do/journal.ts` — append 専用の Journal。intent / outcome / audit / event を 1 表に `kind` で持ち、
  `seq` はトランザクションで採番する。本文は 256KB まで行に置き、超えるものは `env.OBJECTS` に置いて
  hash / key だけ残す。outcome は `applied` / `conflict` / `unknown` に加えて `denied`（machine が書く前に
  拒否した）を持ち、denied も intent を settle する。読み出しは cursor、切り詰めは checkpoint の watermark
  （[durability.md §5](../../docs/durability.md)）。
- 内部 RPC: `POST /rpc/apply`（intent → machine → outcome）、`GET /rpc/read?projectRoot=&path=`（machine から）、
  `POST /rpc/journal/watermark`、`POST /rpc/lease/{acquire,renew,release}`。edge には公開しない。
- 環境: `HNS_AGENT_URL`（machine の origin）と `HNS_CONTROL_PLANE_KEY`（Worker の secret。base64url の
  Ed25519 seed）。どちらか欠けるとファイル面は 503 で閉じる。machine の選択と鍵の配布は 0148。

## D1 と DO

- D1 は Worker だけが触る。DO から D1 を直接触らない（0150 / 0146）。
- `WorkerEnv.DB` は `@hns/store` の `D1Binding`。`workerFor()` が `bindings.d1({ name })` を1件だけ宣言する。binding 不在・D1 障害は 0149 以降の face が 503 にする。
- 会話の D1 索引は 0149。0146 は DO 内のメタデータまで。

## 開発・検証

```bash
npm test -w @hns/server
npm run typecheck -w @hns/server
npm run build -w @hns/server
```

配備の入口は [tools/deploy/worker.ts](../../tools/deploy/worker.ts)。edge と `Session` / `Workspace` を re-export する。
コマンドは cf だけを使う（wrangler を直接実行しない）。

```bash
cd tools/deploy
XDG_CONFIG_HOME=$PWD/../../.work/cf/config XDG_CACHE_HOME=$PWD/../../.cache cf dev --mode development
```

`HNS_SESSION_SECRET` は `.dev.vars`（gitignore、32文字以上）に置く。cf dev の local state は
`XDG_CONFIG_HOME` 配下に残る。`--persist-to` は cf dev が受け付けない。
