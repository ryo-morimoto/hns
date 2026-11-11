# 0150: store を D1 専用にする（node:sqlite の削除）

status: done
priority: now
depends-on: 0144
touches: packages/store/src/**, packages/store/test/**, packages/store/package.json, packages/store/README.md, packages/store/CHANGELOG.md, package.json, package-lock.json, docs/packages.md, docs/engineering.md, docs/testing.md, docs/decisions.md, AGENTS.md, work/BOARD.md, work/LANES.md, work/issues/0166-migration-rollback.md, work/issues/0173-docs-followups.md

## Goal

制御データの store を D1 だけで動かす。0047 の node:sqlite は D047 / D049 より前の過渡的な実装なので削除する。
テストとローカルは miniflare / cf dev の実 D1 SQLite を使う。

## Acceptance criteria

- [x] `openStore({ d1 })` と全リポジトリが async で、D1 だけで動く
- [x] `packages/store` に `node:sqlite` の import が無い
- [x] migration は `schema_migrations` の1つの runner で、同じ SQL を D1 に適用する
- [x] 「実 SQLite でテストする」規律を維持（D1 は miniflare の実 SQLite）
- [x] 0/1・JSON 文字列・連番を外に出さない規則を維持
- [x] pure な parse / schema は unit、DB の振る舞いは integration でテスト
- [x] 破壊的な公開 API 変更を D064 と README / CHANGELOG に記録
- [x] `npm run check` が通る

## テスト条件

- C1: Given 空の D1 / When openStore / Then `schema_migrations` は 1 で、default project がある
- C2: Given 既存の D1 / When 再 open / Then データが残り、migration は冪等
- C3: Given `schema_migrations` が最新より新しい / When openStore / Then fail closed
- C4: Given 各リポジトリの操作 / When D1 で実行 / Then 公開モデルが返り、storage shape は漏れない
- C5: Given 重複 node id の graph / When createRun / Then run と nodes が両方残らない
- C6: Given resumeRuns / When update + select / Then batch で原子に適用される
- C7: Given 壊れた row / When 読む / Then ValiError で落ちる
- C8: Given 非 ISO clock / When open / Then 書き込み前に拒否される
- C9: Given close 後 / When リポジトリを呼ぶ / Then Error で落ちる

## テスト設計

- T1: C1–C3, C9 / 境界値（空・最新・最新+1）/ integration / `test/integration/store/store.test.ts`
- T2: C4–C7 / 代表値と失敗経路 / integration / `test/integration/store/{projects,conversations,events,workflows,automations,usage}.test.ts`
- T3: C8 / 異常入力 / integration / `test/integration/store/store.test.ts`
- T4: parse / schema / 単体 / `src/parse.test.ts`, `src/schemas.test.ts`

## Notes

- async 化は D1 が Promise のみのため。読み→書きの順序は現状維持（以前も読みはトランザクション外）。
- migration は deploy 時にも `migrateStore(d1)` で呼べる。
- miniflare は devDependency（exact pin）。workerd を起動するので integration 層に置く。
- D1 は `BEGIN` と `PRAGMA user_version` を受け付けない。複数文の原子性は `batch` で表す（`exec` はテストの setup 専用）。

## 未確定

- U-01: deploy config の D1 binding を 0145 / 0176 のどちらで足すか。0150 は store 層まで。

## やらないこと

- D1 binding の deploy 設定（0145 / 0176）、server / GraphQL / D1 索引（0145, 0149, 0176）
- identity（0048）、テーブル定義の変更、ORM、Node 側 CLI 用の別バックエンド

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-11: 二重バックエンドは負債と判断（利用者は Worker だけ、D1 の制約を node:sqlite が隠す）。D1 専用に変更し、node:sqlite を削除する。
- 2026-11-11: D1 専用で実装。`npm run check` green（249 tests）。reviewer-0150 が PASS（初回・修正 diff・rebase 解消とも blocking なし）。low は修正済み。
- 2026-11-11: 0145 の上に rebase し、main に統合（cff01f4、249 tests）。

## Result

- verdict: **PASS**（修正 diff の再レビューも PASS）
- reviewer: reviewer-0150
- HEAD: bd1fabe（base a701f79。0145 b67262e の上に rebase 済み）
- blocking: なし
- low（初回、修正済み）: docs/testing の `:memory:` 前提、BOARD / LANES の二重化表記、migrate の rollback TSDoc、`D1Binding.exec` の未使用、migration rollback のテスト欠落
- low（再レビュー、修正済み）: LANES の commit 前後表現、Result の欠落、Notes の exec、BOARD / LANES の順序、0166 の parity パス、harness の TSDoc
- 検証: `npm run check` green（249 tests。store は unit 24 + integration 24）、build、deploy --dry-run、knip。`grep node:sqlite packages/store` は README / CHANGELOG の説明のみ。
- 未確認: 実 Cloudflare D1 の制約（batch 上限、cross-request の binding 再利用）、`@cloudflare/workers-types` の `D1Database` と `D1Binding` の構造一致（0176 で実 env を型付けして確認）。deploy の D1 binding は U-01。
- 変更: `issue/0150-d1-only`（base a701f79、0145 b67262e の上に rebase 済み）。main に統合（cff01f4）。
- 残件（main 既存）: 0176 の `depends-on` と BOARD の依存列が一致していない（reviewer-0150 の指摘）。
