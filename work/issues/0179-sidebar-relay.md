# 0179: サイドバーを Relay で読む（最初の 1 画面）

status: done
priority: now
depends-on: 0178, 0102
touches: packages/web/src/app/, packages/web/test/, packages/web/src/__generated__/, packages/web/README.md, work/issues/0179-sidebar-relay.md, work/BOARD.md, work/LANES.md

## Goal

既存のサイドバー（0102）を Relay の fragment に置き換え、最初の画面を通す。
0115 の overview は hold のままなので、まず既存の会話一覧で通す。

## Acceptance criteria

- [x] サイドバーが Relay の fragment で conversations を読む（component が選択を持つ）
- [x] 同じ画面を 2 回開くと network 0 回（テストで固定）
- [x] 初回の DO RPC がワークスペース数以下（テストで数える）
- [x] 索引が遅れたときの「更新中」表示を後から足せる形にする（0149）
- [x] 既存の Shell テストが通る
- [x] `npm run check` が通る

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | シェルを開く → Sidebar が fragment で読む → conversations / tasks が表示される | 高 | 受入1 |
| C2 | 同じ environment で開き直す → network が増えない（store から返る） | 高 | 受入2 |
| C3 | 1 project を開く → Workspace の read は 1 回（= 1 DO RPC） | 中 | 受入3 |
| C4 | 会話ルートを開く → 会話の title が fragment のデータから出る | 中 | 受入1 |
| C5 | 既存の Shell テスト 14 本 → Suspense 経由で通る | 高 | 受入5 |
| C6 | npm run check | 高 | 受入6 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C4 | 結合（実 Relay + 偽 fetch） | unit | packages/web/src/app/Shell.test.tsx |
| T2 | C5 | 既存の回帰 | unit | 同上（14 本） |
| T3 | C6 | ゲート | static / build | npm run check |

## Notes

- 実測: 再訪 network 0、初回 12 RPC（[RESULTS.md](../../work/poc/graphql-relay/RESULTS.md) §14）
- 鮮度: この時点は store-or-network（再訪 network 0）。network-only に切り替えるかの方針は 0181
- 0115 の overview は 0149 の後に別 issue で通す

## Design: reference-level

- 選択は component が持つ。`Sidebar` が `SidebarProjects` / `SidebarConversations` / `SidebarTasks` の fragment を定義し、`useFragment` で描く。Shell が2つの query（`ShellProjectsQuery`、`ShellWorkspaceQuery`）を `useLazyLoadQuery`（`fetchPolicy: "store-or-network"`）で実行し、fragment ref を渡す。0178 の `createRelaySource` は削除する。
- 会話・タスクは 1 project = 1 `ShellWorkspaceQuery`。初回の DO RPC は選択中のワークスペース数（1）に固定する。project 未選択では `@include(if: $hasProject)` で field を skip し、request 自体を送らない。
- 2 回目の表示は Relay の store から返る（network 0）。テストは harness の `calls` で数える。
- 遅延は Suspense の fallback、失敗は `QueryBoundary` の画面（読み込み直すボタン）で答える。「更新中」の表示は索引（0149）で足す。
- global id は表示に使わず、URL と model の比較は復号した raw id で行う（`fromGlobalId`）。

## Result

- verdict: **PASS**（初回 PASS: blocking 0 / 低 8 → 修正 → 再レビュー PASS）
- reviewer: review-0179（この変更を書いていない別エージェント）。最終判定 HEAD 31a8276 + 低の追修正。
- 受入: 6/6。`npm run check` は ok（24 秒、codegen 込み）。web は 46 tests（Shell 15 / 失敗系 3 / viewModel 5 ほか）。
- 実測: 初回の read は `ShellProjectsQuery` + 選択 project の `ShellWorkspaceQuery` の2回（DO RPC は 1）。同じ environment での開き直しは 0 回。
- 残件（低）: シェル全体が Suspense に包まれるため、初回と未キャッシュの切替では chrome も fallback に替わる（本文・サイドバー単位の boundary は 0149 以降）。project 未選択時は sentinel id を組み立てるが request は送られない（projectId を nullable にするには schema 変更が要る）。workspace の typed failure と reload 実行のテストは未追加。実サーバの DO RPC 数と E2E は 0160 以降。
- 記録: [work/records/0179.yaml](../records/0179.yaml)（verified）。

## やらないこと

- overview（0115）
- ライブ更新（0159）

## Log

- 2026-11-10: 作成（user。D055）。
- 2026-11-17: 実装。Sidebar が `SidebarProjects` / `SidebarConversations` / `SidebarTasks` の fragment を持ち、`useFragment` で描く。Shell は 2 つの query（`ShellProjectsQuery`、`ShellWorkspaceQuery`）を `useLazyLoadQuery`（store-or-network）で読み、project 未選択では `@include(if: $hasProject)` で会話・タスクを skip（request を送らない）。Suspense と ErrorBoundary を `QueryBoundary` に置き、0178 の `createRelaySource` と `workspaceSource` を削除した。web 45 tests / `npm run check` 通過。
- 2026-11-17: 独立レビュー PASS（blocking 0、低 8）。低を反映: README を現在に更新、Design / Notes を実装に合わせ、失敗画面に「読み込み直す」、`taskStatusOf` を閉じた union に、失敗系（typed failure / network / malformed id / unknown status）のテストを追加、dead な `loading` prop を削除。
- 残件（低）: Suspense がシェル全体を包むため、初回と未キャッシュの切替では chrome も fallback に替わる（本文・サイドバー単位の boundary は 0149 以降の仕上げ）。project 未選択時は skip 用の sentinel id を組み立てる（request は送られない）。
