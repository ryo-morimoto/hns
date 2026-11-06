# 0047: store の SQLite 基盤（migrations + repositories）

status: done
depends-on: 0046
touches: packages/store/src, packages/store/test, packages/store/README.md, packages/store/package.json

## Goal

PoC の `db.mjs` を `packages/store` に移し、server が SQL を書かずに済む形にする。

## Acceptance criteria

- [x] migration runner（冪等・実 SQLite・foreign key 有効）
- [x] テーブル: projects / tasks / conversations / workflows / workflow_runs / workflow_nodes / automations / firings / usage_log / events
- [x] repository API（create / get / list / update / delete）と Row → 公開型の `parse`
- [x] 書き込みはトランザクション、失敗は rollback
- [x] 実 SQLite（temp / :memory:）のテスト。永続化はモックしない
- [x] `packages/store/src/index.ts` から公開する

## Notes

- identity（users / sessions / secrets 等）は 0048。ここでは触らない。
- 0032 の store 移植のうち、DB とリポジトリの部分。
- Row の形（0/1・JSON 文字列・連番）は store の外に出さない。
- 既存の PoC `control.sqlite`（`user_version` 4）は移行しない。新しい path を使う。store は自分より新しい version を fail closed で拒否する。

## やらないこと

- 認証・秘密（0048）。
- HTTP と server の組み立て（0035）。
- ORM を入れない。

## Log

- 2026-11-07: 作成。
- 2026-11-07: `openStore`、migrations、repositories、tests を実装。`npm run check` green（store 31 tests）。
- 2026-11-07: 独立 review（store-review）FAIL: migration が新しい `user_version` を黙って飛ばす、`metrics()` が status null で落ちる。修正し再 review を依頼。
- 2026-11-07: 再 review FAIL: 非 ISO の注入 clock で「書いてから throw」する新欠陥。clock を open 時に検証し、失敗時は接続を閉じるように修正。三度目の review を依頼。
- 2026-11-07: 三度目 FAIL: `setLastFiredAt` が非 ISO を書いて読み取りで落ちる。ISO を書き込み前に検証。clock の初回 tick を保持。四度目の review を依頼。
- 2026-11-07: 四度目 PASS。残った low 3件は 0065 に切り出した。

## Result

- migration v1（10 テーブル + index、foreign key、WAL、`user_version`）。再 open は冪等。未知のより新しい version は fail closed。
- repository は `store.projects` / `tasks` / `conversations` / `events` / `workflows` / `automations` / `usage`。書き込みは transaction。
- Row は `schemas.ts` の valibot で公開型へ parse。壊れた row は throw（回帰テストあり）。
- `WorkflowRepository.getRunGraph` が run 開始時の graph を返す（workflow 更新後も固定）。
- tests: store 31。`npm run check` green（168 tests、lint / fmt / tsc / build / knip）。
- 独立 review: **store-review / PASS / HEAD 9eedd17**。blocking は4件見つかり、すべて修正:
  migration version skip、metrics の status null、非 ISO clock の commit-then-throw、`setLastFiredAt` の非 ISO。
- 非 blocking の残件は [0065](0065-store-low-followups.md)。
