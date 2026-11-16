# 0178: web に Relay environment とテスト harness を置く

status: in-progress
priority: now
depends-on: 0177
touches: packages/web/src/, packages/web/test/, packages/web/{package.json,tsconfig.json,vite.config.ts,vite.relay.ts}, packages/web/schema.graphql, packages/server/src/graphql/, packages/server/package.json, tools/codegen/, tools/gate/stages.ts, relay.config.json, package.json, package-lock.json, vitest.config.ts, docs/decisions.md, work/issues/0178-web-relay-environment.md, work/BOARD.md, work/LANES.md

## Goal

web から `/graphql` を Relay で読む土台を作る。あわせて、0100 の網羅 fixture map を置き換える。
（D055 の決定に伴い、fixture の仕組みは作り直してよい。）

## Acceptance criteria

- [x] environment（network + store）を 1 箇所で作り、テストから差し替えられる
- [x] network は fetch を注入できる（テストで実 HTTP を出さない）
- [x] `WorkspaceSource` と `fixtureSource`（0188 で導入）を Relay に置き換え、画面テストの harness を用意する
      （画面ごとの fixture か、モデルから生成した fixture）
- [x] `relay.config.json` と生成先を決め、生成物をコミットする（ヘッダに generated と再生成コマンド）
- [x] 既存の render テスト（12 本）が新しい harness で通る
- [x] TanStack Query は画面状態用に残す（GraphQL の読みは Relay）
- [x] `npm run check` が通る

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | environment → fetch を差し替えて query を送る → 実 HTTP を出さずに data が返る | 高 | 受入1・2 |
| C2 | 同じ operation を2回読む → 2回目は store から返り network が増えない | 中 | 受入3 |
| C3 | 失敗（QueryFailure / 非 2xx）→ 空配列でなく throw する | 高 | 受入3 |
| C4 | global id を含む応答 → shell は model の raw id を受け取る | 中 | 受入3 |
| C5 | 既存の Shell テスト 12 本 → 新しい harness で通る | 高 | 受入5 |
| C6 | codegen → schema.graphql と artifact が再生成され、commit と一致する | 中 | 受入4 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C4 | 故障注入・往復 | unit | packages/web/src/app/relaySource.test.ts |
| T2 | C5 | 既存の回帰 | unit | packages/web/src/app/Shell.test.tsx |
| T3 | C6 | 生成の一致 | static | npm run codegen（0180 でゲート化） |
| T4 | 受入7 | ゲート | static / build | npm run check |

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
- 2026-11-17: 実装。`createEnvironment`（network + store、fetch 注入可）、`ProjectsQuery` / `WorkspaceQuery` の artifact、`createRelaySource`（global id を model の id に復号、1 project 1 read を共有）、fixture を GraphQL payload に置き換え、Shell は environment から source を作る。schema は `buildSchemaSdl()` から `npm run codegen` で生成（D074）。web 41 tests / `npm run check` 通過。
- 2026-11-17: fragment のコロケーション（component が選択を持つ）は [0179](0179-sidebar-relay.md)。この issue の `createRelaySource` は shell の読みを Relay に移す橋で、0179 で消える。
