# 0228n: plain tsc は gateway/handler.test.ts で落ちるが gate の tsrs は緑

status: open
priority: next
design: agreed
design-ref: docs/procedures/testing.md
depends-on: -
touches: packages/server/src/gateway/handler.test.ts, packages/server/tsconfig.json

## Goal

`node node_modules/.bin/tsc --noEmit -p packages/server/tsconfig.json` が
`gateway/handler.test.ts(352,33): error TS2488: Type 'Headers' must have a '[Symbol.iterator]()' method that returns an iterator.`
で落ちる。**main checkout でも同じ**。gate の typecheck は `tsrs` なので 0 エラーで、gate は緑。
つまり **plain tsc と tsrs で同じ設定を読んでいるのに結果が違う**（`Headers` の iterable 化と lib の食い違い）。
エディタや外部 CI が plain tsc を使うと、gate と違う結果になる。

## Acceptance

- [ ] 原因を特定する（tsconfig の lib / types、`@types/node` の版、tsrs の差）
- [ ] plain tsc でも 0 エラーにする（テスト側の `[...headers]` を配列化、または tsconfig の lib を揃える）
- [ ] gate が緑のまま

## Log

- 2026-11-18: 0228 の実装担当とレビュー担当が独立に確認。gate は `tools/gate/stages.ts` の `tsrs`。
