# 0047: store の SQLite 基盤（migrations + repositories）

status: in-progress
depends-on: 0046
touches: packages/store/src, packages/store/test, packages/store/README.md

## Goal

PoC の `db.mjs` を `packages/store` に移し、server が SQL を書かずに済む形にする。

## Acceptance criteria

- [ ] migration runner（冪等・実 SQLite・foreign key 有効）
- [ ] テーブル: projects / tasks / conversations / workflows / workflow_runs / workflow_nodes / automations / firings / usage_log / events
- [ ] repository API（create / get / list / update / delete）と Row → 公開型の `parse`
- [ ] 書き込みはトランザクション、失敗は rollback
- [ ] 実 SQLite（temp / :memory:）のテスト。永続化はモックしない
- [ ] `packages/store/src/index.ts` から公開する

## Log

- 2026-11-07: 作成。
- 2026-11-07: `openStore`、migrations、repositories、tests を実装。`npm run check` green（store 29 tests / 全体 164 tests）。
- 2026-11-07: 独立 review（store-review）FAIL: migration が新しい `user_version` を黙って飛ばす、`metrics()` が status null で落ちる。修正し再 review を依頼。
- 2026-11-07: 再 review FAIL: 非 ISO の注入 clock で「書いてから throw」する新欠陥。clock を open 時に検証し、失敗時は接続を閉じるように修正。三度目の review を依頼。
- 2026-11-07: 三度目 FAIL: `setLastFiredAt` が非 ISO を書いて読み取りで落ちる。ISO を書き込み前に検証。clock の初回 tick を保持。四度目の review を依頼。

## Notes

- identity（users / sessions / secrets 等）は 0048。ここでは触らない。
- 0032 の store 移植のうち、DB とリポジトリの部分。
- Row の形（0/1・JSON 文字列・連番）は store の外に出さない。

## やらないこと

- 認証・秘密（0048）。
- HTTP と server の組み立て（0035）。
- ORM を入れない。
