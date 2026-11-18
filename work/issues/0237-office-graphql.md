# 0237: GraphQL に文書プレビューとエンジン状態を足す

status: open
priority: now
design: agreed
design-ref: D059, D103, docs/office.md
depends-on: 0234, 0236
touches: packages/server/src/graphql/office.ts, packages/server/src/graphql/schema.ts, packages/server/src/graphql/mutations/index.ts, packages/server/src/do/office.ts, packages/server/src/do/session.ts, packages/server/src/do/alarm.ts, packages/server/src/do/machine.ts, packages/server/src/edge/handler.ts, packages/server/src/edge/worker.ts, packages/core/src/types.ts, packages/core/src/graphql/, packages/server/test/fixtures/schema.graphql, packages/web/schema.graphql, packages/web/src/__generated__/

## lead の補足（0234〜0236 の Result から）

- **machine の `op:"office"` は 0236 で動く**。**server → machine の署名済み RPC 経由の実経路は未検証**（0236 は machine の HTTP route のみ）——**この issue で初めて通す**。
- **machine の `GET /artifact`** は **request target 全体にバイト一致で署名**している。**server は URL を組み立て、同じバイト列で署名を検証する**（**正規化してから署名し、正規化しないで配らない**）。**range で引いてストリーム**する（バッファしない）。
- **machine は 1 workspace 前提**（0236 の残件）。**`workspaceId` を DO の行のキーに含め**、**machine へ渡す前に「この Session の workspace か」を確かめる**（**照合しないまま渡さない**）。
- **`DocumentPreview` の 7 状態**は D103 / `docs/office.md` が正。**`not_authorized` を union の失敗側**に置く（7 状態に詰めない）。

## Intent

アプリの契約は GraphQL 1 本（D059）。プレビューの状態・生成の要求・エンジンの可用性を、既存の認可・失敗 union・
DO の行に乗せる。edge の 1 リクエストは 10 秒なので、**生成は mutation の中で待たず、alarm が実行する**。

## Goal

`documentPreview(path)` / `requestDocumentPreview(path)`（どちらも union）と `officeEngine` が載り、
生成は alarm が行い、状態は DO の行に残る。プレビュー PDF は Session 認可の route からチャンクでストリームされる。

## Acceptance criteria

- [ ] `documentPreview(path)` は `DocumentPreviewResult = DocumentPreview | OfficeFailure` を返す
      （`not_authorized` は union の失敗側。7 状態に無理に詰めない）
- [ ] `requestDocumentPreview(path)` は、`officeEngine` の能力で**形式が対象外なら `unsupported` 行**、**manifest が無ければ `disabled` 行**を作り、
      それ以外（machine 不達を含む）は `queued` 行 + alarm を arm して**即座に返る**（edge の 10 秒に収まる。engine 照会は短い timeout）
- [ ] alarm が行を `generating` にし、machine を呼び、`ready` / `failed` を書く。結果は行に残る
- [ ] 同じ `(path, version)` の request は冪等（queued / generating / ready の行を再利用）。
      **終端行（`disabled` / `unsupported` / `failed`）は request 時に置換する**（pack 導入後に再 request できる）
- [ ] machine に届かないときは `stale`。alarm が再試行し、上限で `failed`（engine_unavailable）に倒す
- [ ] alarm は既存の wake と office の TTL を**合成**する（`min`。idle で消えない）
- [ ] `officeEngine` は union（`OfficeEngineAvailable | OfficeEngineUnavailable`）
- [ ] 失敗は `OfficeErrorCode` enum + `OfficeFailure`
- [ ] `GET /api/office/preview?workspaceId=…&path=…&v=…` が Session 認可で、machine の `GET /artifact` を range で引いて
      ストリームする（バッファしない・署名 URL を作らない）
- [ ] `office.job` を `EVENT_NAMES` に追加し、監査イベントを 1 本出す（本文なし）
- [ ] 同じ path の古い版の行は、request 時に削除する

## テスト条件

- C1: 権限の無いパス → union の `OfficeFailure(not_authorized)`、行を作らない
- C2: 同じ `(path, version)` で 2 回 request → 行 1 つ・alarm 1 つ
- C3: request → queued →（alarm）→ generating → ready、edge は 10 秒以内に返る
- C4: 版が変わって request → 新しい行、古い行は削除
- C5: pack 未導入 → `OfficeEngineUnavailable`、request は `disabled` 行を作る（alarm を arm しない）
- C10: machine 不達 → request は `queued` 行を作り、alarm 後に `stale` → `failed`（`disabled` にしない）
- C6: machine 断 → stale → 再試行 → failed(engine_unavailable)
- C7: 監査に本文・セル値が無い
- C8: route が 31 MB の PDF を、Worker のメモリに載せずに返す（range で 8 MiB ずつ）
- C9: alarm の wake と office TTL の合成（idle でも消えない）

## テスト設計

- T1: C1 → 認可 → unit（resolver）+ integration
- T2: C2/C3/C4 → 冪等・状態・GC → integration（DO）
- T3: C5/C6/C9/C10 → union・alarm（不達を含む）→ unit / integration
- T4: C7 → 監査 → unit
- T5: C8 → ストリーム → integration（大きな fixture）

## Problem / context

web が machine を直接呼ぶと認可・監査・状態の所有者が 2 か所になる。edge の 1 リクエストは 10 秒で、
office の生成は最大 60 秒。したがって mutation は「行を作って alarm を arm」だけを行い、実行は alarm が担う
（レビュー N2）。進捗は live（`/ws`）が会話専用のため、**ポーリング**にする（N3）。

## Users and use cases

- 利用者: 文書を開いたとき「準備中 / できた / 失敗（理由）/ 結果不明」が分かる。
- エージェント: 状態を会話の材料にできる。
- 運用者: `officeEngine` で未設定を診断できる。

## Non-goals

- 実行（0236）・表示（0238）・ツール（0240）。
- live（`/ws`）への office イベント追加（将来。今はポーリング）。
- 権限モデルの変更、共有リンク。

## Options and trade-offs

| Option | Summary | Pros | Cons | Risk | Cost |
| --- | --- | --- | --- | --- | --- |
| A（採用） | GraphQL union + DO 行 + alarm 実行 + 専用 route | 既存の認可・失敗 union・DO に乗る。edge の予算に収まる | 行・alarm・route の実装 | 中 | 中 |
| B | live（`/ws`）に office イベントを足す | 押し出しで速い | `/ws` は会話専用（conversationId 必須）。protocol 変更が 3 か所 | 高 | 中 |
| C | 観測ログを状態にする | 実装が軽い | 30 日・5,000 件で消える | 高 | 小 |
| Do nothing | ポーリングだけで状態を持たない | 実装しない | 失敗の理由・回復が表現できない | 中 | — |

## Recommendation

A。B は会話を持たない文書パネルでは接続できず、protocol 変更も大きい。C は状態にならない。

## Design: guide-level

```graphql
query { documentPreview(path: "提案書.docx") {
  ... on DocumentPreview { status pages bytes url error { code } }
  ... on OfficeFailure { code message } } }
mutation { requestDocumentPreview(path: "提案書.docx") {
  ... on DocumentPreview { status } ... on OfficeFailure { code } } }
query { officeEngine { ... on OfficeEngineAvailable { id version } ... on OfficeEngineUnavailable { reason } } }
```

## Design: reference-level

- 行: `office_preview`（DO SQLite）`(path, version, operation, status, code, pages, bytes, params_hash, engine, updated_at)`。
  route は行の `params_hash` をそのまま使う（server と core で既定値がずれて cache miss になるのを防ぐ）。
- 実行: request が `officeEngine` を短い timeout で引き、状態を決める（形式能力外 → `unsupported`、manifest 無し → `disabled`、
  machine 不達 → `queued` + alarm で後から stale/failed、それ以外 → `queued` + alarm）。
  alarm は `min(wake, office TTL, 次回再試行)` で arm。alarm は行を `generating` にし、machine の `office` op を呼び、
  `ready` / `failed` / `stale` を書く。再試行は 30 秒間隔で 3 回、その後 `failed`。
- 配信: route は Session 認可 → machine の `GET /artifact` を 8 MiB の range で引き、ReadableStream に流す。
- 監査: `office.job` を `EVENT_NAMES` に追加（core の型を更新）。

## Invariants and failure modes

- 認可は resolver と route の入口で 1 回ずつ。
- request の重複は既存行の再利用で畳む（alarm を二重に arm しない）。
- `stale` を `failed` に丸めない（alarm の再試行で決着させる）。

## Cross-cutting concerns

- security: url を capability にしない。route も Session 認可。パスは query で渡す。
- observability: `office.job`（EVENT_NAMES 追加）+ route のバイト数。
- cost: 行は 1 件 / (path, version)。古い版は request 時に削除。

## Compatibility, migration, rollback

SDL の追加のみ。`schema.graphql` は codegen で再生成。ロールバックは field と route の削除（行は残って害なし）。

## Test plan

unit（resolver / 写像 / alarm の合成）、integration（DO 行・alarm・route・GC）、gate（SDL 生成差分）。

## Rollout and graduation

flag で隠す。0238 が使い始めたら既定で有効。

## Notes

- 契約: [docs/office.md](../docs/office.md) §5・§6・§7。
- 既存の失敗表現: `packages/server/src/graphql/failures.ts`。

## 未確定

- U-01: route の認可（Cookie か bearer か）/ 仮説: 既存の Session と同じ / 影響: web / 責任者: user / トリガー: 0238 の設計時。
- U-02: office の TTL と再試行回数（2 分 / 3 回）/ 仮説: これで足りる / 影響: stale の滞留 / 責任者: user / トリガー: 実装時。

## やらないこと

- machine の実行・キャッシュ・変換。
- live への office イベント追加。
- 共有リンク・権限モデルの変更。

## Log

- 2026-11-17: 作成。
- 2026-11-17: レビュー 1 回目（B5/B6/B8）対応。
- 2026-11-17: レビュー 2 回目（N2/N3/N4/N8/N9/N18）対応: union、alarm 実行、ポーリング、route、touches、GC。

## Result

- 設計レビュー: issue-reviewer / **PASS with comments**（2026-11-17、5 ラウンド。blocking 0）
- blocking: なし（R1〜R10 の整合修正を反映済み）
- 次アクション: 0234 → 0235 → 0236 の順で実装レーンへ（0240 / 0242 は設計レビューで agreed に）
