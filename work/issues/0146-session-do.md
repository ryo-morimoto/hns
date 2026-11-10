# 0146: Session DO（PiHarness・会話・run）

status: open
priority: plan
depends-on: 0145
touches: packages/server/src/do/session.ts, packages/agent/src/, packages/agent/test/

## Goal

1 ワークスペースに 1 つの Session DO を置き、pi-durable 1.5.0 の Harness（PiHarness）を載せる。
会話は複数持つ。会話ごとに DO を作らない（D049）。

## Acceptance criteria

- [ ] `openDurableObjectSqliteStorage(ctx.storage)` で Harness を開く
- [ ] `onWake` → DO alarm → `resume()` の経路を実装し、二重に起きても破綻しない
- [ ] eviction 後に会話と状態が戻ることをテストで固定（PoC では 75 秒後に復帰を確認）
- [ ] **1 ワークスペース = 1 Session**。会話は `createConversation` で作り、DO を増やさない
- [ ] commit は message / tool call 境界。token 単位で書かない（行数の上限をテストで固定）
- [ ] `setTimer` を Cloudflare で使わない設定を明示
- [ ] 会話一覧は `scanConversations`。外から引くための索引は 0149
- [ ] WS の受け口（0159）をこの DO に置く

## Notes

- PoC: `work/poc/cf-harness/src/session.js`。1 DO に 1 会話しか使っていなかったが、Session は複数会話を持つ（ベンダー例も同じ）。
- DO の制約: 128MB、CPU 上限、SQLite 10GB/object。履歴が育ったら時間やプロジェクトで分割する（D049 の前提が変わる条件）。
- 実行中の状態はここ、確定したレコードは D1（INV-11）。会話の索引だけ 0149 が D1 に置く。

## やらないこと

- 実プロバイダ（0152）。
- ワークスペースの書き込み（0157）。

## Log

- 2026-11-07: 作成（[D048](../../docs/decisions.md) と [durability.md](../../docs/durability.md) を契約として）。
- 2026-11-07: Session DO と Workspace DO を分ける決定を反映。
- 2026-11-07: 1 会話 = 1 DO をやめ、1 ワークスペース = 1 Session に訂正（D049）。
