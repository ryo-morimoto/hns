# 0149: 会話の索引（D1）

status: done
priority: now
design: agreed
design-ref: D078
depends-on: 0146, 0150, 0189
touches: packages/agent/src/session.ts, packages/agent/src/session.test.ts, packages/agent/test/integration/session.test.ts, packages/server/src/do/, packages/server/src/graphql/, packages/server/test/, packages/store/src/, packages/store/test/, packages/store/package.json, packages/store/tsdown.config.ts, oxlint.config.ts, vitest.config.ts, packages/web/schema.graphql, docs/durability.md, work/issues/0127-model-project-workspace.md

## Goal

Session DO の中にある会話を、外から一覧・検索・ページングで引けるようにする。
**定義・台帳（Project / Task / Workflow / Machine）は D1 が正本**なので、投影しない（D049）。run の状態は 0115 / 0116 が持つ。

## Acceptance criteria

- [x] 索引の列を最小に固定（Conversation モデル + `indexed_at`）。`status` / `machineId` は 0115 / 0116 / 0127 に送る
- [x] Session DO が commit の後に自分の行を書く。順序を決め、失敗しても再送できる（dirtyAt + CAS）
- [x] metadata doc は 32 delta で checkpoint し、revision を有界にする
- [x] 索引が遅れたときの表示（「更新中」）を決める
- [x] 検索は索引の範囲だけ。会話本文の全文検索は範囲外と明記
- [x] cursor pagination のテスト（同時更新で落ちない）
- [x] DO から索引を作り直せる（壊れても正本は失われない）
- [x] D1 障害時: 構造化ログ + `index_state` + `Query.indexState` + 0039 の metrics で検知できる

## Notes

- 0121（検索・pagination）をこの形で置き換える。0115 は run の状態を 0116 で足す。
- 「投影」ではなく「索引」。正本は DO で、D1 は引くための写し。INV-11。
- 定義系の一覧（プロジェクト一覧など）は索引ではなく D1 のテーブルを直接読む。

## Design（D078 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D078）。実装はこの issue の受入で行う。

### 前提（いまの契約）

- 会話の正本は Session DO の `hns.conversation.index`（0146）。D1 の `conversations` は 0047 の PoC 由来で、いまは誰も書かない（server / web / agent からの参照 0）。
- 0145 は「DO から直接 D1 を触らない」としている。0149 は**索引だけの例外**を作る。
- `Query.conversations` は DO の最新 page を読んで project で絞る（0176）。静かな project は欠け得る。
- `status` / `machineId` は DO のメタデータにもモデルにも無い。0115（hold）/ 0116 の WorkItem と 0127 の Project が持つ語彙。
- 0149 が引く INV-11 は durability.md の不変条件表に無い（INV-01〜09）。0149 で定義を足す。

### 決定 1: 表は既存の conversations

- 新しい並行テーブルを作らず、`conversations` を索引にする。migration（landing 時の次の番号。0148 / 0127 と同時に着地しない）で `indexed_at` を足す。`status` / `machine_id` は U-01 の判断まで足さない。
- **D080（0127）により、`conversations` の PK は `(project_id, id)`**。索引の行もこの組で、Session DO は自分の projectId で書く。一覧は project で絞る。
- 列はモデル + `indexed_at`。`deleted_at` は tombstone として写す（一覧から消えるが行は残る）。
- writer は `updated_at` を必ず書く（null は createdAt で埋める）。並びは `updated_at DESC, id DESC`。索引 `(project_id, updated_at DESC, id)` を足す。
- `packages/store/src/conversation-index/` に狭い writer を置く: `upsert` / `delete` / `replaceAll`。`do/**` から `@hns/store` の root を import させない（oxlint の no-restricted-imports で `conversation-index` だけ許可）。

### 決定 2: 書き手は Session DO、outbox はメタデータに持つ

- メタデータに内部フィールド `dirtyAt` を足す（公開 `Conversation` には出さない）。create / send / abort の commit で `dirtyAt = updatedAt` を同じ tx で書く。
- DO の drain: `pendingIndex()` → D1 upsert → `markIndexed(ids, version)` を1 commit で消す。D1 が失敗したら dirtyAt を残し、次の RPC / alarm で再送する。**チャットは D1 の失敗で止めない。**
- clear は CAS: 書いた `updated_at` と一致するときだけ dirtyAt を消す。drain 中に新しい turn が来ても、その dirtyAt を消さない。
- 初回は dirtyAt が無い行を dirty とみなす（backfill）。空の索引に全件を1回書き、以降は dirtyAt だけで回す。
- upsert は単調（`WHERE excluded.updated_at >= conversations.updated_at`）。古い再送が新しい行を戻さない。
- DO は `SessionEnv.DB` を受け取り、`openConversationIndex` だけを作る。制御データは触らない（型と lint で閉じる）。DB が無ければ索引は書かず dirty を残す（チャットは動く）。
- `agent/session.ts` に `dirtyAt` / `pendingIndex` / `markIndexed` を足す。0146 の行予算 C3 を測り直す。
- metadata doc の `checkpointWhen` を `deltasSinceBase >= 32` にする（revision を有界にする）。

### 決定 3: 読みは D1、ページングは keyset

- `Query.conversations(projectId, first, after, q)` は D1 の索引だけを読む。DO RPC を使わない。
- `ConversationList` に `nextCursor` を足す。`listPayload` は共通化せず、会話用の payload を1つ書く（2つ目が来たら考える）。
- cursor は `(updated_at, id)` の base64url。無効は `invalid_argument`。
- 同時更新: 行が前へ動くので重複も取りこぼしもあり得る。無限ループと恒久的な欠落を作らないことをテストし、重複は id で畳む。
- `first` は 1..100。`q` は title の部分一致（既存の LIKE escape）。本文の全文検索はしない。

### 決定 4: 鮮度の表示

- 索引はその turn の中で書く（対話操作）。D1 障害のときだけ遅れる。
- cold load では遅れを検出できない。**「更新中」は live の delta が索引より新しいことを観測したときだけ出す**（0159 / 0181）。行は `updatedAt` の相対時刻を出し、freshness を偽装しない。

### 決定 5: 再構築

- DO の内部 RPC `POST /rpc/reindex`（公開しない）: `scanConversations` + メタデータから全行を upsert し、メタデータに無い行を消す。件数を返す。
- 公開トリガー（ops / GraphQL mutation）は 0039 / 0198 の後。0149 は RPC とテストまで。
- 破損テスト: 1行を壊す → reindex → 一覧が正本と一致する。

### 決定 6: 触るもの

- `agent/src/session.ts`、`server/src/do/{session,state,session-rpc}.ts`、`server/src/graphql/{schema,resolvers,views}.ts`、`store/src/{migrations,conversation-index}/`、`store/src/index.ts`、`store/package.json`（`./conversation-index` の export）、`store/tsdown.config.ts`、`oxlint.config.ts`、各 test。`server/src/routes/lists.ts` は存在しないので消す。
- `docs/durability.md` の不変条件表に「索引は写し」を足す（INV-11 を正式にする）。
- AC から `status` / `machineId` を落とした（D078）。

### 決定（D078）

- **U-01**: `status` / `machineId` は索引に持たない。run の状態は 0115 / 0116、machine は 0127 の Project。
- **U-02**: 遅延は実測する。同一リージョンなら 10ms 台、違えば計測して alarm の間隔を決める。
- **U-03**: **A'**（dirtyAt + clear + `checkpointWhen: deltasSinceBase >= 32`）。
- **U-04**: **3層**（失敗時ログ → `index_state` → `Query.indexState` + 0039 の metrics）。

### U-03 の判断材料（実測、2026-11-17）

Node SQLite の実 storage で 1 text turn を測った（faux、`openSession`）。

| 項目 | 実測 |
| --- | --- |
| 1 turn の追加行（合計） | 10（`record_ids` 4 / `entries` 2 / `submissions` 1 / `document_revisions` 1 / `tasks` 1）。0146 の上限 24 に対して余裕 14 |
| `hns.conversation.index` の revision | create で base 1、send ごとに delta 1（send 2 回で合計 3） |
| 同 doc の read | base + 全 delta を再生する。`checkpointWhen: () => false` なので base は増えない |
| clear commit 1 回 | revision +1、commit +1。turn 合計は 11 行 |
| replay の実測 | 20 / 40 / 60 / 80 / 100 / 120 turns で `listConversations` 0.01〜0.04ms、`getConversation` 0.01ms。revision は 121（1/turn）。傾きは小さく、120 turns では実害なし |
| 影響 | 24 の行予算には収まる（clear 込みで 11 行、余裕 13）。**revision 行が 1/turn で単調に増える**のが唯一の負債。件数が増えても read は軽いが、storage は有界でない |

#### 選択肢

| 案 | 仕組み | turn の追加 | 長所 | 短所 |
| --- | --- | --- | --- | --- |
| A | 現案: metadata の `dirtyAt` + 毎 drain で clear | commit +1、revision +1 | 実装が最小。原子的 | revision が 2/turn で単調に増える（read は軽い） |
| A' | A + `checkpointWhen: deltasSinceBase >= 32` | 通常 +1、32 回に1回 base | revision が 32 で固定され storage が有界。既存の負債も直る | 0146 の doc 定義を1行変える。base 書き込みが稀に入る |
| B | 別 doc `hns.index.outbox`（`{[id]: updatedAt}`）を 8 delta で checkpoint。clear は version 一致で CAS | commit +1、revision +1（別 doc） | metadata は 1 delta/turn のまま | doc が1つ増える。outbox の GC を決める必要 |
| C | DO の生 SQL に outbox テーブル（commit の直後に同期 insert） | commit +0、行 +1（SQL） | pi-durable の delta を増やさない。速い | commit と insert の間の crash で1件落ちる（reindex で回復）。storage 抽象の外 |
| D | turn では drain せず、alarm で 60 秒ごとにまとめる | commit +0〜1/分 | 書き込みが最小 | 索引の遅れが最大 60 秒。対話直後の一覧が古い |

決定: **A'**。実測では read の実害は無いが、revision 行を有界にする1行の変更は安い。B / C / D は、この数字では複雑さか鮮度の犠牲に見合わない。

### U-04 の観測（決定: 3層）

ログだけでは「見る人がいなければ検知にならない」。索引の失敗は 200 で返るので、UI / API に出さないと誰も気づかない。3層にする（軽量案は採らない）。

1. **構造化ログ（診断）**: drain が失敗したときだけ、requestId / workspace / conversationId / attempt / error code / pending を1行。本文・秘密・D1 のメッセージ本文は出さない。
2. **状態（検知）**: D1 に `index_state` を1行/workspace。`pending` / `last_synced_at` / `last_error_code` / `last_error_at`。backlog の発生と解消の遷移だけで書き、毎 turn は書かない。
3. **公開（判断）**: GraphQL `Query.indexState`（owner）と 0039 の `/api/metrics`（`hns_index_pending` / `hns_index_stale_seconds`）。0107 / 0104 は「索引が遅れています」を出す。

- 再送は alarm で backoff（1s → 2s → … → 60s）。成功で 0。
- 再構築は RPC `reindex`（公開トリガーは 0198 の後）。監査イベントを1行（秘密なし）。
- アラートは 0039: pending > 0 が5分続く、または last_synced_at が10分古い。

軽量案（1 + 再構築だけ。検知は 0039 送り）は採らない。その間、索引の遅れはログを見た人しか分からないため。

### テスト条件（案）

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 会話を作る / send する → drain → GraphQL の一覧 → D1 の行が出る（DO RPC を読まない） | 高 | 受入3 |
| C2 | D1 を失敗させる → send → チャットは成功し dirty が残る → D1 回復 → 次の drain → 行が出る | 高 | 受入2 |
| C3 | 古い updatedAt の再送 → upsert → 新しい行が戻らない（単調） | 高 | 受入2 |
| C4 | drain 中に新しい turn → clear → 新しい dirtyAt が消えない（CAS） | 高 | 受入2 |
| C5 | 同時更新を挟んで cursor で辿る → 無限ループせず、恒久的な欠落がない（重複は許す） | 中 | 受入5 |
| C6 | 索引の1行を壊す → reindex → 一覧が DO の正本と一致する | 高 | 受入6 |
| C7 | 既存の会話があり dirtyAt が無い → 最初の drain → 全件が backfill される | 中 | 受入2 |
| C8 | `q` に `%` / `_` / `\` → 部分一致 → ワイルドカードとして解釈しない | 低 | 受入4 |
| C9 | metadata doc に 32 回書く → checkpoint → revision が 32 以下に戻る | 中 | 受入8 |
| C10 | D1 を失敗させる → `index_state.pending` が立ち、成功で 0 に戻る。ログに本文・秘密が出ない | 高 | 受入9 |
| C11 | project A と B の会話 2 → D1 の PK `(project_id, id)` と global id `project:local` が衝突しない。get は project で絞る | 高 | D080 |

層は store の unit（cursor / LIKE / upsert）、server の unit（drain / CAS / reindex の fake D1）、integration（DO SQLite + miniflare D1 で C2 / C6 / C7）。GraphQL の契約テストは C1 / C5。

## やらないこと

- 会話本文の全文検索。
- 集計・分析（0162 / 0163）。

## 追記（2026-11-17 / lead）

0160 / 0181 の後に `next` から `now` へ。D1 の会話索引は 0043 の E2E と 0104 / 0105 の一覧の前提。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-07: 範囲を会話・run の索引に縮小。制御データは D1 直（D049）。
- 2026-11-17: 設計案を追加（レビュー待ち）。既存の `conversations` を索引にし、DO の `dirtyAt` から再送する形にした。
- 2026-11-17: ユーザーの設計レビューで合意（D078）。U-01〜U-04 を決定し、`design: agreed` にした。

## Design（実装、2026-11-17）

D078 の合意を、実装の形に落としたもの。逸脱は「D078 からの差分」に書く。

### 前提の訂正

0127 の時点で D1 の `conversations` の PK は `(id)` 単独だった（A2 の PK 変更は未実施）。0149 の migration 0005 で張り替える。0127 の Result に follow-up として追記した。

### 書き込み（D078 決定 2）

- Session DO は `env.DB` に **直接**書く。Worker RPC は使わない（turn の中で書くため往復を増やさない）。0145 の索引例外。
- 狭い writer は `@hns/store/conversation-index` の1つ: `upsert` / `remove` / `replaceAll` / `state` / `writeState`。DO は root を import しない（`packages/server/src/do/session-index.ts` に oxlint の no-restricted-imports）。
- metadata doc（`hns.conversation.index`）に内部 `dirtyAt` と `indexedAt` を足す。公開 `Conversation` には出さない。create / send / abort の commit で `dirtyAt = updatedAt`。
- `pendingIndex(limit)` は dirty（`dirtyAt` あり）と未索引（`indexedAt` なし = backfill）を返す。1回の drain は 50 行まで（CPU を turn に持ち込まない）。
- 順序: `pendingIndex` → D1 upsert（単調 `WHERE excluded.updated_at >= COALESCE(conversations.updated_at, conversations.created_at)`）→ `markIndexed(entries)`（`dirtyAt === version` のときだけ消す CAS。`indexedAt` は書いた version で更新）。
- 失敗: 行は書けたが CAS が失敗した場合も dirty を残す。D1 が失敗したら dirty を残し、次の会話 RPC（2xx）か alarm で再送する。**チャットは止めない。**
- metadata doc の `checkpointWhen` は `deltasSinceBase >= 32`（revision を有界にする）。
- `index_state` は workspace（= Session DO 名）ごとに1行。backlog の発生・解消とエラーの遷移だけ書く（毎 turn は書かない）。成功で `last_synced_at` と `pending = 0`、失敗で `last_error_code = d1_write_failed` と `pending`。

### 読み（D078 決定 3）

- `Query.conversations(projectId, first, after, q)` は D1 の索引だけを読む。DO RPC は使わない。詳細は DO。
- keyset `(COALESCE(updated_at, created_at), id)` 降順。`nextCursor` は base64url の `[updatedAt, id]`。無効は `invalid_argument`。`first` は 1..100。
- `q` は title の部分一致（LIKE の escape は store）。本文の全文検索はしない。
- 未知の projectId は 0127 と同じく **D1 を読む前に** `invalid_argument`（DO を作らない）。
- 一覧に出るのは `indexed_at` が入った行だけ（索引に書かれた行）。legacy の未索引行は backfill が上書きする。
- 同時更新: 行が前へ動くと、その1回の走査では見えないことがある（重複もし得る）。無限ループと恒久的な欠落を作らないことだけを固定する。

### 鮮度（D078 決定 4）

- 索引はその turn の中で書く。遅れるのは D1 障害のときだけ。
- cold load では遅れを検出できない。0149 は `index_state` と `Query.indexState` を出すところまで。画面の「更新中」は live の delta が索引より新しいことを観測したときだけ（0159 / 0181、UI は 0104 / 0105）。行は `updatedAt` の相対時刻を出し、freshness を偽装しない。

### 再構築（D078 決定 5）

- DO の内部 RPC `POST /rpc/reindex`（公開しない）。`indexRows()`（storage の全 conversation + metadata）から全行を upsert し、**その DO の project** の行だけを「metadata に無いもの」として消す。legacy default DO に混在する他 project の行は upsert のみ（その project の DO が新しい行を書いている可能性があるため消さない）。
- `replaceAll` は強制 upsert（reindex は正本）。drain の upsert だけが単調。

### migration 0005

- `conversations` を再作成して PK を `(project_id, id)` にし、`indexed_at TEXT`（NULL = 未索引）を足す。既存行は全部コピーする。旧 PK は新 PK の上位集合なので衝突しない。衝突したら batch が rollback し、store は開かない（fail closed、半端な DB を残さない）。
- 索引 `conversations_activity (project_id, updated_at DESC, id)`。`index_state (workspace_id PK, pending, last_synced_at, last_error_code, last_error_at, updated_at)`。
- legacy の行は `indexed_at = NULL`。backfill の対象で、一覧には出ない。

### GraphQL

- `ConversationList` に `nextCursor: String`。`Query.conversations` に `after` / `q`。
- `Query.indexState(projectId): IndexStateResult`（`IndexState | QueryFailure`）。`pending` / `lastSyncedAt` / `lastErrorCode` / `lastErrorAt`。owner は現状セッション（単一 owner）。ユーザー単位の scope は accounts 面で足す。
- SDL が変わるので `packages/web/schema.graphql` を codegen で再生成する。

### D078 からの差分（報告済み・承認済み）

- 0039 の `/api/metrics`（`hns_index_pending` / `hns_index_stale_seconds`）は 0162 の obs 面（DO ローカル SQLite、D1 を読まない）なので 0149 では実装しない。0149 は構造化ログ + `index_state` + `Query.indexState` までを証拠にする。metrics は 0162 へ申し送り。
- 専用の backoff alarm は作らない。harness の alarm と競合するため、再送は既存 alarm と次の会話 RPC で行う。索引の遅れの上限は「次の会話操作まで」で、alarm が動くのは run 中か wake があるとき。
- metadata に `projectId` が無い古い行は `default` に寄せる（legacy default DO と同じ扱い）。件数は `index.legacy_rows` の構造化ログに出す。
- drain の失敗で `index_state` を書けないこともある（D1 障害）。そのときは次の drain が状態を読み直す。

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 会話を作る / send する → drain → GraphQL の一覧 → D1 の行が出る（DO RPC を読まない） | 高 | 受入2・3 |
| C2 | D1 の索引書き込みを失敗させる → send → 200 で chat は成功、dirty が残り `index_state.pending` が立つ → D1 回復 → 次の RPC → 行が出て pending が 0 | 高 | 受入2・9 |
| C3 | 古い updatedAt の再送 → upsert → 新しい行が戻らない（単調）。reindex の強制 upsert は戻す | 高 | 受入2 |
| C4 | drain 中に新しい turn → markIndexed（古い version）→ 新しい dirtyAt が消えない（CAS） | 高 | 受入2 |
| C5 | 同時更新を挟んで cursor で辿る → 無限ループせず、動かなかった行は欠けない（動いた行は次の読みの先頭） | 中 | 受入5 |
| C6 | 索引の1行を壊す → reindex → 一覧が DO の正本と一致し、正本に無い行は消える | 高 | 受入6 |
| C7 | 既存の会話があり indexedAt が無い → 最初の drain → 全件が backfill される（batch 上限で分割） | 中 | 受入2 |
| C8 | `q` に `%` / `_` / `\` → 部分一致 → ワイルドカードとして解釈しない | 低 | 受入4 |
| C9 | metadata doc に 32 回書く → checkpoint → revision が 32 以下に戻る | 中 | 受入3 |
| C10 | D1 を失敗させる → `index_state.pending` が立ち、成功で 0 に戻る。ログに本文・秘密が出ない | 高 | 受入9 |
| C11 | project A と B の同じ会話 id → D1 の PK `(project_id, id)` で衝突せず、get は project で絞る | 高 | D080 |
| C12 | 未知の projectId → `Query.conversations` / `Query.indexState` は `invalid_argument` で、索引を読まず DO も作らない | 高 | 0127 |
| C13 | 無効な `after` → `invalid_argument`、索引を読まない | 高 | 受入5 |
| C14 | 0001 の DDL で作った既存 DB → 0005 → 行が残り、`indexed_at` は NULL、同じ id を別 project に置ける | 高 | 受入1・migration |
| C15 | `index_state` に記録が無い workspace → 0 と null（「同期済み」と偽らない）。GraphQL はそれを返す | 中 | 受入9 |
| C16 | 既存の会話一覧（GraphQL の payload / enum / union）→ 形が変わらず、`nextCursor` が増えるだけ | 中 | 互換 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1・C2・C10 | 故障注入（D1 失敗 → 回復）+ 契約 | unit（実 SQLite の D1 fake + fake Session） | `packages/server/src/do/session-index.test.ts` "a successful turn writes its conversation into the D1 index" / "a D1 failure leaves the turn successful, the row dirty, and the backlog recorded" |
| T2 | C3 | 単調性の境界 | integration（miniflare D1） | `packages/store/test/integration/store/conversation-index.test.ts` "an older row never overwrites a newer one" / "a rebuild replaces the stored row whatever its timestamp says" |
| T3 | C4 | 競合（CAS） | unit（MemoryStorage + faux） | `packages/agent/src/session.test.ts` "a turn that commits during a drain is still pending afterwards" |
| T4 | C5 | 競合 + 境界 | integration（miniflare D1） | `packages/store/test/integration/store/conversations.test.ts` "a keyset cursor pages through a stable list..." / "a row updated between pages does not stall or truncate the cursor walk" |
| T5 | C6 | 故障注入（壊れた行） | unit（実 SQLite の D1 fake） | `packages/server/src/do/session-index.test.ts` "a rebuild repairs the index from the object's metadata" / "a rebuild that cannot read the object is a 500..." |
| T6 | C7 | 状態遷移（backfill）+ 境界（batch） | unit（MemoryStorage + faux） | `packages/agent/src/session.test.ts` "a created conversation is pending until its version is marked indexed" / "a drain returns at most the requested batch and reports the rest" / in-source `pendingVersion` |
| T7 | C8 | 同値分割（ワイルドカード） | integration（miniflare D1） | `packages/store/test/integration/store/conversations.test.ts` "conversations are registered, searched..." |
| T8 | C9 | 状態遷移（checkpoint） | unit（MemoryStorage） | 0146 の row 予算テスト + `checkpointWhen` の実測（Result に数字）。専用の revision テストは置かない（doc の内部値で、契約は「有界」） |
| T9 | C11・C14 | 状態遷移（migration）+ 分離 | integration（miniflare D1） | `packages/store/test/integration/store/migrate.test.ts` "the index migration keeps every conversation and scopes the key to the project" / `conversations.test.ts` "a conversation is fetched by its project and id pair" |
| T10 | C12・C13 | 契約（拒否） | unit（edge + GraphQL） | `packages/server/src/graphql/handler.test.ts` "conversations for an unknown project never address a Session object" / "an invalid conversation cursor is a typed failure" / "an unknown project has no index state" |
| T11 | C15 | 境界（記録なし） | integration（miniflare D1） | `conversation-index.test.ts` "the index state reads zeroed when absent and round-trips a transition" |
| T12 | C16 | 契約（互換） | unit（GraphQL） | `handler.test.ts` "a project's conversations are served from the D1 index" / "a conversation page returns the next cursor and continues from it" |
| T13 | 受入1・3・4・9 | ゲート | static / build | `npm run check` |
| T14 | C1・C2・C14 | 実経路（workerd の Session DO + D1、旧 DDL からの 0005 再構築、FK 失敗 → 回復） | integration（cf dev） | `packages/server/test/integration/session-do.test.ts` "the Session DO writes the conversation index into D1 and retries after a failure" / "the index migration rebuilds a database created with the old conversations key" |

層の判断: SQL・PK・migration・keyset・単調性は実 D1（miniflare の workerd）で証明し、DO と D1 binding の実経路（旧 DDL → 0005、FK 失敗 → 再送）は cf dev の1本で固定する。DO の drain / reindex / 状態遷移は実 SQLite の D1 fake と scripted Session で unit に置く。CAS と backfill は agent の unit（MemoryStorage）。GraphQL の契約は handler の unit。同じシナリオを複数の層で回さない。

## Log（実装）

- 2026-11-17: 実測（checkpoint の効果）。`hns.conversation.index` を 40 回書く（create 40 回）と、`document_revisions` の行は **7**（base + 直近の delta。32 delta で checkpoint し、それ以前の delta は畳まれる）。変更前は 1 行/turn で単調に増えた（0146 の実測で 120 turn → revision 121）。revision は 33 前後で有界になる。
- 2026-11-17: 実装。store に migration 0005（PK 張り替え + `indexed_at` + `index_state`）と `conversation-index` の writer、keyset の repository、agent に `dirtyAt` / `indexedAt` / `pendingIndex` / `markIndexed` / `indexRows` と `checkpointWhen`、server に `SessionIndex`（drain / reindex / index_state）と `/rpc/reindex`、GraphQL に `nextCursor` / `after` / `q` / `Query.indexState`。`docs/durability.md` に INV-11。


## Result

- verdict: **PASS**（reviewer-0149、blocking 0）
- reviewer: reviewer-0149（この変更を書いていない別エージェント）
- HEAD: 6f51b7d（main に ff 統合）
- 受入: 8/8（最後の metrics は 0039 → 0162 の /api/metrics に申し送り。0149 は構造化ログ + index_state + Query.indexState まで）。gate は exit 0（876 tests / 133 files。main の 1 回目は既知の cf dev flake、再実行で green）。
- 確認: Session DO → D1 binding の狭い writer（session-index.ts）、dirtyAt + pendingIndex（50 件上限）+ markIndexed の CAS、updated_at 単調 upsert。D1 失敗で turn は 200 のまま dirty が残り次の RPC で回復。GraphQL 一覧は D1 のみ（keyset cursor、未知 project は D1 / DO に触れず invalid_argument）、詳細は DO。migration 0005 で conversations の PK を (project_id, id) + indexed_at に張り替え（旧 DDL からの cf dev 再構築、行保持、衝突は fail closed）。backfill は metadata の projectId（legacy default の混在は default に寄せて件数ログ）。40 writes → 7 document_revisions（~33 で有界）。
- 非 blocking（中 3 / 低 5、follow-up）: reindex と drain の同時実行（公開トリガー前に直列化）/ lastSyncedAt の意味（正常系で更新されない）/ 本番で drain を起こす経路がまだ 0（0104 / 0105 で用意）/ conversations_activity が ORDER BY に効かない（updated_at に揃える）/ pendingIndex の読み取り失敗が 0 と記録される / 50 の定数が二重 / ページングと legacy 混在のテスト穴 / FK 前提が docs にない。
