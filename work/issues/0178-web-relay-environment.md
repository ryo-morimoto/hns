# 0178: web に Relay environment とテスト harness を置く

status: open
priority: now
depends-on: 0177
touches: packages/web/src/app/, packages/web/test/, packages/web/package.json, packages/web/schema.graphql, relay.config.json, vitest.config.ts

## Goal

web から `/graphql` を Relay で読む土台を作る。あわせて、0100 の網羅 fixture map を置き換える。
（D055 の決定に伴い、fixture の仕組みは作り直してよい。）

## Acceptance criteria

- [ ] environment（network + store）を 1 箇所で作り、テストから差し替えられる
- [ ] network は fetch を注入できる（テストで実 HTTP を出さない）
- [ ] `WorkspaceSource` と `fixtureSource`（0188 で導入）を Relay に置き換え、画面テストの harness を用意する
      （画面ごとの fixture か、モデルから生成した fixture）
- [ ] `relay.config.json` と生成先を決め、生成物をコミットする（ヘッダに generated と再生成コマンド）
- [ ] 既存の render テスト（12 本）が新しい harness で通る
- [ ] TanStack Query は画面状態用に残す（GraphQL の読みは Relay）
- [ ] `npm run check` が通る

## Notes

- pin: relay-compiler / react-relay / relay-runtime 20.1.1、graphql 16.11.0（PoC で実測）
- 生成物の量の実測: 88 行の手書きに対して 7 ファイル / 660 行（[RESULTS.md](../../work/poc/graphql-relay/RESULTS.md) §13）
- テストは「サーバ契約」と「store 描画」を分ける（D055）
- codegen をゲートに入れるのは 0180
- テスト管理の新方針（0183）に従う。テストの置き場所は 0186 で移行するため、この issue では現行の `packages/web/test` のまま。
- 0183 が `vitest.config.ts` を先に触るため、0178 は 0183 の後に rebase する。

## やらないこと

- 全画面の移行（0179 が最初の 1 画面）
- Relay の subscriptions

## Log

- 2026-11-10: 作成（user。D055）。
- 2026-11-10: 0188 で typed client と網羅 fixture map を削除した。置き換え対象は `WorkspaceSource`。
