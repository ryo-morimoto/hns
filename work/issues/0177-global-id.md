# 0177: id を型をまたいで一意にする（Relay の store 要件）

status: in-progress
priority: now
depends-on: 0176
touches: packages/core/src, packages/core/test, packages/server/src/graphql/, packages/server/test/

## Goal

Relay の正規化 store は、同じ id を 2 つの型に割り当てられない。PoC では `Item` が会話 id を
そのまま返し、`Conversation` と衝突した（Relay が実行時に警告）。境界で global id に変換する。

## Acceptance criteria

- [x] `toGlobalId(type, id)` / `fromGlobalId(globalId)` を `@hns/core/graphql` に置き、GraphQL の境界だけで使う
- [x] 同じ id が 2 つの型に現れないことをテストで固定（Conversation と Item の衝突）
- [x] 不正な global id は想定内の失敗として返す（例外にしない）
- [x] REST 面の id は変えない（GraphQL だけ global id）
- [x] `npm run check` が通る

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | Project の id → toGlobalId → fromGlobalId → 同じ type と id | 中 | 受入1 |
| C2 | 同じ raw id を Conversation と Item に付ける → 別の global id | 高 | 受入2 |
| C3 | 不正な global id（空・base64 でない・区切り無し・空の型/id）→ ok:false、例外にしない | 高 | 受入3 |
| C4 | raw id / 別型の id を projectId に渡す → QueryFailure(invalid_argument) | 高 | 受入3 |
| C5 | view の id / projectId が global id になる（Project / Conversation / Task） | 中 | 受入4 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C3 | 往復・同値分割 | unit | packages/core/src/graphql/global-id.test.ts |
| T2 | C4 | 故障注入 | unit | packages/server/src/graphql/handler.test.ts |
| T3 | C5 | 契約 | unit | packages/server/src/graphql/views.test.ts |
| T4 | 受入5 | ゲート | static / build | npm run check |

## Notes

- 実測: [RESULTS.md](../../work/poc/graphql-relay/RESULTS.md) §14 に警告の全文
- node interface は今は導入しない。必要になったら（再取得を id で行うとき）足す
- brand（`ConversationId`）は内部のまま。global id は境界の表現

## Design: reference-level

- `@hns/core/graphql` に `toGlobalId(type, id)` / `fromGlobalId(value)` を置く。表現は base64url(`<Type>:<id>`)。
- `toGlobalId` は型名が GraphQL 名（`[_A-Za-z][_0-9A-Za-z]*`）で、id が空でないことを確かめ、違えば `Error` を投げる（プログラマの誤り）。
- `fromGlobalId` は失敗を返す（例外にしない）。`{ ok: true, value: { type, id } }` か `{ ok: false, reason: "malformed" | "unsupported_type" }`。base64 の復号失敗・区切り無し・空の型/id・GraphQL 名でない型を `malformed` にする。
- 境界は server の resolver と view だけ。model の型（`ProjectId` / `ConversationId`）と D1 の行は変えない。
- view は `id` と参照 id（`projectId`）を global id にし、resolver は引数の global id を復号して model の型へ戻す。型が合わない（例: `Conversation` の id を `projectId` に渡す）のは `invalid_argument`。

| 型 | 例 | 備考 |
| --- | --- | --- |
| Project | `toGlobalId("Project", "default")` | 一覧と参照の両方 |
| Conversation | `toGlobalId("Conversation", "1")` | Task は raw id（型の衝突が無い）が、0177 では全部に付ける |

## やらないこと

- REST の id 形式の変更
- node interface / `node(id:)` の実装（今は不要）

## Log

- 2026-11-10: 作成（user。D055）。
- 2026-11-10: core の graphql サブパスに置く（0188。core のルートはモデルだけ）。
- 2026-11-17: 実装。`@hns/core/graphql` の `toGlobalId` / `fromGlobalId`（base64url(`<Type>:<id>`)）、view の id を global 化、resolver で `projectId` を復号（型違い・生 id は `invalid_argument`）。core 4 tests、server の契約テスト 3 追加。