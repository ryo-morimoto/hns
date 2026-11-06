# 0047: store の SQLite 基盤（migrations + repositories）

status: open
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

## Notes

- identity（users / sessions / secrets 等）は 0048。ここでは触らない。
- 0032 の store 移植のうち、DB とリポジトリの部分。
- Row の形（0/1・JSON 文字列・連番）は store の外に出さない。

## やらないこと

- 認証・秘密（0048）。
- HTTP と server の組み立て（0035）。
- ORM を入れない。
