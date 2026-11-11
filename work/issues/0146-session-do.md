# 0146: Session DO（PiHarness・会話・run）

status: done
priority: now
depends-on: 0145
touches: packages/agent/src/, packages/agent/test/, packages/agent/{package.json,tsdown.config.ts,README.md,CHANGELOG.md}, packages/server/src/do/, packages/server/src/index.ts, packages/server/test/, packages/server/{package.json,README.md,CHANGELOG.md}, tools/deploy/worker.ts, tools/deploy/tsconfig.json, tools/gate/stages.ts, tools/gate/test/stages.test.ts, vitest.config.ts, package-lock.json, docs/{packages,engineering}.md, docs/decisions.md, work/issues/0145-worker-edge.md, work/issues/0146-session-do.md, work/BOARD.md, work/LANES.md

## Goal

1 ワークスペースに 1 つの Session DO を置き、pi-durable 1.5.0 の Harness（PiHarness）を載せる。
会話は複数持つ。会話ごとに DO を作らない（D049）。
会話の title / project / timestamps は DO に残し、0149 が D1 の索引に写せるようにする。

## Acceptance criteria

- [x] `openDurableObjectSqliteStorage(ctx.storage)` で Harness を開く
- [x] `onWake` → DO alarm → `resume()` の経路を実装し、二重に起きても破綻しない
- [x] eviction 後に会話と状態が戻ることをテストで固定
- [x] **1 ワークスペース = 1 Session**。会話は `createConversation` で作り、DO を増やさない
- [x] commit は message / tool call 境界。token 単位で書かない（row 上限をテストで固定）
- [x] `setTimer` を Cloudflare の durable wakeup に使わない設定を明示
- [x] 会話一覧は `scanConversations`。外から引くための索引は 0149
- [x] WS の受け口（0159）をこの DO に置く
- [x] 開発・検証・配備のコマンドは cf のみ（wrangler を直接使わない）
- [x] `npm run check` が通る

## テスト条件

- C1: 1 workspace = 1 DO。`createConversation` を 2 回呼んでも DO は 1 つ、`scanConversations` が 2 件を返す。
- C2: 会話を作り faux の 1 turn を送ると、transcript に user / assistant が入り、title / project / timestamps が返る。
- C3: text turn の追加 row が 24 以下。token ごとの commit ならこの上限を超える。
- C4: close / reopen（Node SQLite）で会話・transcript・メタデータが戻る。
- C5: `armWake` は active → `now+60s`、at → `at`、none → alarm 削除。二重呼び出しで同じ結果。
- C6: 不在 ID / 不正 body / 不正 limit は型付き失敗。model 不在は 503。想定外だけ 500。
- C7: cf dev の test Worker 経由で create → send → list → transcript。同じ `XDG_CONFIG_HOME` で再起動しても戻る。
- C8: `cf deploy --dry-run` が Session export を含む bundle を作る。`wrangler` コマンドは実行しない。

## テスト設計

- unit（agent / MemoryStorage + faux）: 2 会話、list/get、send/transcript、metadata、invalid id。
- unit（server / fake alarm storage）: `armWake` の active / at / none / 二重 arm。
- integration（agent / Node SQLite）: temp DB で turn の row 数、close→reopen。
- integration（server / cf dev）: 一時 cf project の test Worker から DO RPC を呼ぶ。create/send/list/transcript、cf dev を同じ `XDG_CONFIG_HOME` で再起動。wrangler は使わない。
- gate: `npm run check`、`cf deploy --dry-run`。

## Problem / context

0145 は入口を作ったが、`/ws` の転送先は 501 のスタブで、会話も run も存在しない。pi-durable 1.5.0 は DO SQLite 用 storage、`Harness.wake()` / `onWake`、`createConversation` / `scanConversations` を提供しており、PoC で alarm / resume / eviction 復帰の形は確認済み。製品側に必要なのは、この形を Worker-safe に組み立て、会話メタデータと複数会話を扱い、cf だけで検証できる状態にすること。

## Users and use cases

- 0146 の実装者: 1 つの DO で複数会話を作り、faux の turn を送り、再起動後も戻ることを確認する。
- 0176 の実装者: 会話一覧・単体・transcript を GraphQL resolver から DO 経由で引く。
- 0149 の実装者: `scanConversations` とメタデータから D1 の索引行を作る。

## Non-goals

- 実プロバイダ（0152）。0146 は development の faux だけを動かし、staging / production は 503。
- Workspace のツール実行・書き込み（0147 / 0157）。会話は text-only。
- WS のメッセージ型・再接続（0159）。DO の `/ws` は 501 のまま。
- D1 の索引（0149）と GraphQL resolver（0176）。
- title の rename / archive / delete（0029 / 0130）。

## Options and trade-offs

| Option | Summary | Pros | Cons / Risk | 採用 |
| --- | --- | --- | --- | --- |
| A | `@hns/agent/session`（Worker-safe）に複数会話 runtime、server は薄い DO | 組み立てを agent に集約。Node root を Worker に持ち込まない | agent に `./session` export と build entry が増える | **推奨** |
| B | server が pi-durable を直接 compose | build 依存が減る | 組み立てが agent と server に分散 | 却下 |
| C | 会話ごとに `openAgent` / DO | 既存 API を使える | D049 に反する。Node 依存 | 却下 |
| Do nothing | 501 のまま | リスク 0 | 会話・run が無い | 却下 |

メタデータは session-scoped の 1 document（`hns.conversation.index`）に置く。会話ごとの document は一覧で N read になり、0149 の索引作成が fan-out するため。

## Recommendation

A。`openSession` を Worker-safe な agent サブパスに置き、Session DO は lifecycle（open / alarm / wake / recovery / RPC）だけを持つ。会話メタデータは 1 document にまとめ、send は 0146 では settlement まで待つ。0152 / 0159 で admit + stream に分割する。

## Design: guide-level

`openSession({ storage, models, registry, model, context })` が複数会話の runtime を返す。
`createConversation({ title, projectId })`、`listConversations(limit)`、`send(id, text)`、`transcript(id, limit)`、`abort(id)` を使う。
DO はこの runtime を 1 つ持ち、内部 RPC（`/rpc/conversations...`）を提供する。Edge は `/graphql` と `/ws` だけを公開し、RPC は公開しない。

## Design: reference-level

### Agent session（`packages/agent/src/session.ts`）

- node: を import しない。依存は `@hns/core`、pi-durable、chord/context、`events.ts`、`transcript.ts`。
- `openSession` は `Harness.open` に `onWake` を渡し、**`setTimer` を渡さない**。durable wakeup は `onWake` / DO alarm。background timer は pi-durable が Workers で decline する。
- `conversationCreated` で `configure(tx, id, { model })`。
- `createConversation` は `harness.createConversation({ ownership: {kind:"ownerless"}, init })`。`init` で `hns.conversation.index` に title / projectId / createdAt / updatedAt / isArchived / deletedAt を書く。
- `listConversations` は `storage.scanConversations({order:"descending"})` + index 1 read。root は除外。
- `send` は submit → wait → `lastAssistantText`。settlement 後に index の `updatedAt` を 1 commit で更新。
- `Conversation` は core の型。数値の pi-durable ID は文字列化し、`ConversationIdSchema` / `ProjectIdSchema` / `isoTimestamp` で検証する。壊れたメタデータは既定値に落とさない。

### Session DO（`packages/server/src/do/session.ts`）

- plain class `Session`（`cloudflare:workers` を継承しない）。`constructor(state, env)`、`fetch`、`alarm`。
- `state.blockConcurrencyWhile` で `openDurableObjectSqliteStorage(state.storage, { prefix: "hns_session" })` → `openSession`。
- `onWake` → `armWake`。`alarm` は active 中に heartbeat（+60s）を arm し、`resume()` の後に実際の `wake()` を arm する。
- `session.closed` が failed なら `state.abort("harness failed")`。初期化失敗も `state.abort`。
- 内部 RPC: create / list / get / transcript / messages / abort。`/ws` は 501（0159）。
- body 上限は 0145 の `DEFAULT_LIMITS.maxBodyBytes`。期待失敗は `code` 付き JSON、想定外だけ 500。
- model は `do/models.ts`。development かつ `faux/<id>` だけ faux。それ以外は 503（0152 まで）。

### cf only

- コマンドは `cf dev` / `cf deploy --dry-run` / `cf deploy` のみ。wrangler を直接実行しない。
- `cf dev` は `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` を workspace 内へ（`--persist-to` は cf dev が拒否する）。
- gate の deploy stage は `WRANGLER_LOG_PATH` をやめ、`XDG_*` を使う。
- `wrangler` は cf の内部 bundler 依存としてのみ残す（U-01）。

## Invariants and failure modes

- S-01: 1 workspace = 1 Session DO。会話ごとに DO を作らない。
- S-02: 会話・transcript・メタデータは DO SQLite に永続し、DO 再生成で戻る。
- S-03: 1 text turn の追加 row は 24 以下。
- S-04: durable wakeup は `onWake` → alarm → `resume()` のみ。`setTimer` を渡さない。
- S-05: 二重 alarm / 二重 resume で run を二重に作らない。
- S-06: 期待失敗は `code` 付き。秘密・prompt・cookie をログに出さない。
- S-07: staging / production は 0152 まで 503。

## Cross-cutting concerns

- 認証は edge（0145）。DO RPC は binding からのみ。
- 観測: `onReport` は kind と error.name だけ。完全な hop は 0162。
- 費用: 1 DO / 1 workspace。metadata index は 0149 で D1 へ。
- 運用: rollback は Worker version。DO SQLite は戻らない（0144 と同じ）。

## Compatibility, migration, rollback

- 既存の product DO データは無い。prefix `hns_session` を初版から固定する。
- 0145 の edge は変えない。`Session` の export 名を維持する。
- rollback は 0145 の 501 スタブに戻る。データは残る。
- agent root の Node API は変えず、`./session` を追加するだけ。

## Test plan

- C1〜C8 を上の層で実行する。
- cf integration は test support が一時 cf project を作り、`cf dev`（同じ `XDG_CONFIG_HOME`）で起動。test Worker が DO RPC に転送する。プロセス group を SIGTERM し、同じ state で再起動して復帰を確認する。
- cf が見つからない場合だけ skip。wrangler に fallback しない。
- row 数は SQLite の全テーブルの COUNT 差分。上限 24 rows / text turn。
- `npm run check` と `cf deploy --dry-run`。

## 未確定

| ID | 論点 | 仮説 / 決定 | 責任者・トリガー |
| --- | --- | --- | --- |
| U-01 | wrangler パッケージ自体も禁止か | cf の内部 bundler 依存として残す。直接実行しない | user。依存自体を拒否したとき |
| U-02 | send を wait のままにするか | 0146 は wait。0152 / 0159 で admit + stream | author。実モデルで 10s を超えたとき |
| U-03 | metadata index が育ちすぎる | 1 session document。0149 で D1 へ | 0149。会話数 1,000 超 |
| U-04 | title の rename / archive / delete | 0029 / 0130 | 0029。UI が rename を必要としたとき |
| U-05 | staging / production の model | 0152 まで 503 | 0152 |

## やらないこと

- 実プロバイダ（0152）、Workspace のツール（0147 / 0157）、WS メッセージ（0159）、D1 索引（0149）、GraphQL（0176）。
- PoC の `conversationId` データ移行。
- wrangler コマンドでの開発・検証・配備。

## Log

- 2026-11-07: 作成（[D048](../../docs/decisions.md) と [durability.md](../../docs/durability.md) を契約として）。
- 2026-11-07: Session DO と Workspace DO を分ける決定を反映。
- 2026-11-07: 1 会話 = 1 DO をやめ、1 ワークスペース = 1 Session に訂正（D049）。
- 2026-11-11: ユーザー指示で now に上げ、実装開始。CLI は cf のみ（D064）。設計は issue 内に置く。
- 2026-11-11: `work/BOARD.md` / `work/LANES.md` を `touches` から外した（lead 所有。並列の単位をファイルに緩めた決定に伴う）。
- 2026-11-11: 実装。`@hns/agent/session`（複数会話・メタデータ・transcript）、Session DO（plain class、
  `openDurableObjectSqliteStorage`、onWake/alarm/resume、内部 RPC）、faux model、cf dev integration。
  `npm run check` は 277 tests / 57 files、build / deploy dry-run / knip 通過（最終確認）。
- 2026-11-11: cf dev（XDG_CONFIG_HOME を workspace 内）で product Worker と test Worker を起動して確認:
  /graphql 401→501、/ws 401→501、/api/debug 404、x-request-id、create→send→list→transcript、
  cf dev 再起動後の復帰。`--persist-to` は cf dev が受け付けないため使わない。
- 2026-11-11: `docs/durability.md` は 0141 の未コミット変更と重なるため、0146 では触らない。
- 2026-11-11: reviewer-0146 が **FAIL**（blocking 3）。不正 limit が型付き失敗にならない、row 上限テストが
  token 単位 commit を検出できない、alarm 経路が未テスト。limit を valibot で検証して 400 にし、RPC の
  400/404/413/415/503/500 を unit で固定。row テストを長い応答 + assistant entry 1 件に強化。
  `Session` に runtime factory を注入し、fake DO state + 実 Harness で alarm を二重に呼ぶ integration を追加。

## Result

- verdict: **PASS**（初回 FAIL: blocking 3 → 修正 → 再レビュー PASS）
- reviewer: reviewer-0146（この変更を書いていない別エージェント）
- HEAD: 024bb03（実装 commit。再レビューは 6bbe21a + staged diff）
- 受入: 10/10。`npm run check` は 277 tests / 57 files、lint / fmt / typecheck / build / deploy dry-run / knip がすべて ok。
- blocking（初回、いずれも解消）:
  - 不正 limit が型付き失敗にならなかった → valibot で正整数・上限を parse し 400。RPC の 400/404/413/415/503/500 を unit で固定。
  - row 上限テストが短すぎて token 単位 commit を検出できなかった → 200 語の応答 + assistant entry 1 件に強化。
  - alarm 経路が未テストだった → fake DO state + 実 Harness で alarm を 2 回呼び、alarm の arm と resume 呼び出しを観測。空実装なら落ちる。
- non-blocking（残し）:
  - `ModelUnavailableError` の RPC 分岐は、現在 model 不在が DO open 時に 503 になるため防御的（到達しない）。
  - cf integration の test project は cf dev の dev server として `wrangler` を package.json に宣言する。
    cf の内部 bundler であり、直接コマンドは実行しない（D065 / U-01）。
  - 実 WebSocket upgrade（101）と、eviction を 75 秒待つ形の確認は未実施。cf dev の再起動で storage recovery は確認。
- 未確認: 実際の WebSocket upgrade（101）を `new Request(...)` で DO へ転送する経路、staging / production の 503 実経路、
  実プロバイダ（0152）、実 cf deploy、長時間 eviction。
- cf は `cf dev` / `cf deploy --dry-run` のみ。product Worker と test Worker の両方を cf dev で起動して確認した。
