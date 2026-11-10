# 0177: id を型をまたいで一意にする（Relay の store 要件）

status: open
priority: now
depends-on: 0176
touches: packages/core/src, packages/core/test, packages/server/src/graphql/, packages/server/test/

## Goal

Relay の正規化 store は、同じ id を 2 つの型に割り当てられない。PoC では `Item` が会話 id を
そのまま返し、`Conversation` と衝突した（Relay が実行時に警告）。境界で global id に変換する。

## Acceptance criteria

- [ ] `toGlobalId(type, id)` / `fromGlobalId(globalId)` を `@hns/core/graphql` に置き、GraphQL の境界だけで使う
- [ ] 同じ id が 2 つの型に現れないことをテストで固定（Conversation と Item の衝突）
- [ ] 不正な global id は想定内の失敗として返す（例外にしない）
- [ ] REST 面の id は変えない（GraphQL だけ global id）
- [ ] `npm run check` が通る

## Notes

- 実測: [RESULTS.md](../../work/poc/graphql-relay/RESULTS.md) §14 に警告の全文
- node interface は今は導入しない。必要になったら（再取得を id で行うとき）足す
- brand（`ConversationId`）は内部のまま。global id は境界の表現

## やらないこと

- REST の id 形式の変更
- node interface / `node(id:)` の実装（今は不要）

## Log

- 2026-11-10: 作成（user。D055）。
- 2026-11-10: core の graphql サブパスに置く（0188。core のルートはモデルだけ）。
