# 0178: web に Relay environment とテスト harness を置く

status: done
priority: now
depends-on: 0177
touches: packages/web/src/, packages/web/test/, packages/web/{package.json,tsconfig.json,vite.config.ts,vite.relay.ts,README.md}, packages/web/schema.graphql, packages/server/src/graphql/, packages/server/{package.json,tsdown.config.ts}, tools/codegen/, tools/gate/stages.ts, relay.config.json, package.json, package-lock.json, .oxfmtrc.json, vitest.config.ts, docs/decisions.md, work/issues/0178-web-relay-environment.md, work/BOARD.md, work/LANES.md

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

## Result

- verdict: **PASS**（初回 FAIL: blocking 2 → 修正 → 再レビュー PASS、低 1 を修正）
- reviewer: review-0178（この変更を書いていない別エージェント）。最終判定 HEAD 92c4c7a。
- 受入: 7/7。`npm run check` は ok（24 秒、build / deploy / knip 込み）。web は 44 tests。
- blocking（解消済み）:
  - `npm run codegen` の出力が整形済み commit と一致せず、codegen 直後に fmt が落ちた → `__generated__` を oxfmt の対象外にし、raw 出力を commit。schema ヘッダと README に再生成コマンドを明記。
  - `@hns/server` の `./graphql` が dist に存在しなかった → tsdown の entry に `src/graphql/index.ts` を追加し、default 条件の import を通した。
- 低の修正: QueryFailure / store 再利用 / 失敗 read の再試行のテスト、issue 番号の除去、`endpoint` option の削除、docs/packages.md の export 追記、README と TSDoc の更新、`oxfmt docs` で混入した整形の revert。
- 残件（低）: runs は WorkflowRun の GraphQL 投影が無いため空（投影は別 issue）。実サーバとの `/graphql` 往復（E2E）と dev proxy は未確認（0160 以降）。`babel-plugin-relay` は nested の graphql@15 を peer に持つ。
- 記録: [work/records/0178.yaml](../records/0178.yaml)（verified）。

## やらないこと

- 全画面の移行（0179 が最初の 1 画面）
- Relay の subscriptions

## Log

- 2026-11-10: 作成（user。D055）。
- 2026-11-10: 0188 で typed client と網羅 fixture map を削除した。置き換え対象は `WorkspaceSource`。
- 2026-11-17: 実装。`createEnvironment`（network + store、fetch 注入可）、`ProjectsQuery` / `WorkspaceQuery` の artifact、`createRelaySource`（global id を model の id に復号、1 project 1 read を共有）、fixture を GraphQL payload に置き換え、Shell は environment から source を作る。schema は `buildSchemaSdl()` から `npm run codegen` で生成（D074）。web 41 tests / `npm run check` 通過。
- 2026-11-17: fragment のコロケーション（component が選択を持つ）は [0179](0179-sidebar-relay.md)。この issue の `createRelaySource` は shell の読みを Relay に移す橋で、0179 で消える。
- 2026-11-17: 独立レビュー 1回目 FAIL（blocking 2: codegen の再現性（整形済み artifact と raw 出力の不一致）と、server の `./graphql` が dist に無い）。artifact を oxfmt の対象外にして raw を commit、schema ヘッダと README に再生成を明記、tsdown の entry に `src/graphql/index.ts` を追加。C2 / C3 のテストを追加（store 再利用、QueryFailure）。再レビュー **PASS**（blocking 0、低 8）。
- 2026-11-17: 再レビューの低を反映。`oxfmt docs` で混入させた docs の整形（約 400 行）を戻し、`docs/packages.md` の2行だけ残した。web README の古い記述（fixture 前提）を更新、失敗 read の再試行テストを追加、artifact ヘッダに再生成コマンドを書かない判断を D074 に追記。
- 2026-11-17: 残件（低）: runs は WorkflowRun の GraphQL 投影が無いため空（投影は別 issue）。実サーバとの `/graphql` 往復（E2E）は未確認。`babel-plugin-relay` は nested の graphql@15 を peer として持つ（直接依存は 16.11.0 で固定）。