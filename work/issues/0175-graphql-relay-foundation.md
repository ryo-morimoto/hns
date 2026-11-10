# 0175: core で SDL を起こす（GraphQL の型を手で書かない）

status: done
priority: now
depends-on: 0037
touches: packages/core/src, packages/core/test, package.json, package-lock.json, docs/decisions.md

## Goal

D055 の前提。GraphQL の schema を `core` のモデルから起こし、SDL とモデルの不一致を型検査で落とす。
schema-first にしない（型が正本。AGENTS.md）。server と web は同じ SDL だけを読む。

## Acceptance criteria

- [x] `buildSdl()` が `types.ts` から SDL を生成し、決定性がある（テスト）
- [x] 生成した SDL がゴールデン `test/fixtures/schema.graphql` と一致する
- [x] `buildSchema(query)` が `validateSchema` を通る（Query は 0176 が渡す）
- [x] モデルに field を足すと型検査が落ちる（`FieldTable<T>` の `-?`）
- [x] id は `ID!` で公開し、内部の brand は出さない（global id は 0177）
- [x] enum の公開名は SCREAMING_SNAKE_CASE、内部値は const array と一致（テスト）
- [x] field 名は明示（camelCase）。boolean は `is`/`has` を `defineEntity` が強制する
- [x] SDL に載せないモデル型は `EXCLUDED` に理由付きで列挙する
- [x] `graphql` 16.11.0 を exact pin し、理由を D055 に追記
- [x] `npm run check` が通る

## Notes

- 出発点: [work/poc/graphql-relay/src/gql.mjs](../../work/poc/graphql-relay/src/gql.mjs) の SDL（12 行）
- 配布（G-02）: core が SDL 文字列を export し、web は build 時に `schema.graphql` を書く。
  web が core のファイルパスを深く参照しない
- 生成は実行時ではなく build 時。Web の bundle に SDL を入れない
- 計測: [RESULTS.md](../../work/poc/graphql-relay/RESULTS.md) §6（graphql-js の固定費 0.17ms）

## Result

- verdict: **PASS**（初回 FAIL: blocking 2 件 → 修正 → 再レビュー PASS）
- reviewer: graphql-reviewer（この変更を書いていない別エージェント）
- HEAD: 3c09f8a（未 commit の作業ツリーをレビュー）
- blocking: 2 件。どちらも修正済み。
  - `EXCLUDED` に `ChatResponse` が無かった（モデル型の漏れ）
  - 登録済み enum を `kind:"scalar" / "String"` で書いても型検査を通った
- 受入: 10/10。`npm run check` exit 0（lint / fmt / tsrs / 72 tests / build / knip、21 秒）
- non-blocking: 3 件を修正（`NAME_EXCEPTIONS` の残存記述、boolean テストの `// Catches:`、型名の検査を
  実効のある集合比較に変更）。1 件は既知の限界として残す: `EXCLUDED` は `types.ts` の追加を自動検出しない。
- 未 commit。コミットは user の指示による。

## やらないこと

- schema-first（SDL を手で書き、型を生成する）
- graphql-codegen で web の型を作ること（型は core のモデルのまま）
- relay-compiler の導入（0178）

## Log

- 2026-11-10: 作成（user。D055 の採用を受けて。旧 0175「土台」を分割）。
- 2026-11-10: 実装。`@hns/core/graphql`（`buildSdl` / `buildSchema` / `buildTypes`）と型付き spec。
  11 テスト（決定性、ゴールデン、validateSchema、ID、nullability、enum、除外リスト、名前の拒否）。
  `npm run check` 通過（lint / fmt / tsrs / 72 tests / build / knip）。
- 計画からの差分: (a) `buildSchema` は Query を引数に取る（Query は 0176）。(b) `lexicographicSortSchema` は使わず、
  型と field を名前順・enum の値を宣言順にして生成側で固定（schema と SDL の成果物を一致させるため）。
  (c) コミットする SDL は web に置く（0178）。
- status は in-progress。独立レビュー待ち（この変更を書いていないエージェント）。
- 2026-11-10: レビューの blocking 2 件を修正。
  (1) `EXCLUDED` に `ChatResponse` を追加。(2) 登録済み enum を `kind:"scalar" / "String"` で書くと型検査を
  通ってしまったので、`EnumRef` のみに制限（実測: `Type '"scalar"' is not assignable to type '"enum"'`）。
  併せて boolean の `is`/`has` を `defineEntity` で強制し、未使用だった `NAME_EXCEPTIONS` を削除。
  `buildSdl` に generated ヘッダを付け、`buildSchema` の型順を `buildSdl` と一致させた。
  `npm run check` 通過。再レビュー待ち。
