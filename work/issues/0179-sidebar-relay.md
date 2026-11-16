# 0179: サイドバーを Relay で読む（最初の 1 画面）

status: in-progress
priority: now
depends-on: 0178, 0102
touches: packages/web/src/app/, packages/web/test/, packages/web/src/__generated__/, work/issues/0179-sidebar-relay.md, work/BOARD.md, work/LANES.md

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
- 鮮度: この時点では network-only で明示的に取り直す。方針は 0181
- 0115 の overview は 0149 の後に別 issue で通す

## Design: reference-level

- 選択は component が持つ。`Sidebar` が `ProjectsQuery` と `WorkspaceQuery(projectId)` を `useLazyLoadQuery`（`fetchPolicy: "store-or-network"`）で読み、0178 の `createRelaySource` は削除する。Shell は route と選択だけを持つ。
- 会話・タスクは 1 project = 1 `WorkspaceQuery`。初回の DO RPC は選択中のワークスペース数（1）に固定する。
- 2 回目の表示は Relay の store から返る（network 0）。テストは harness の `calls` で数える。
- 遅延・更新中は Suspense の fallback と `useIsFetching` の口を用意し、索引（0149）が入ったら「更新中」を出す。
- global id は表示に使わず、URL と model の比較は復号した raw id で行う（`fromGlobalId`）。

## やらないこと

- overview（0115）
- ライブ更新（0159）

## Log

- 2026-11-10: 作成（user。D055）。
- 2026-11-17: 実装。Sidebar が `SidebarProjects` / `SidebarConversations` / `SidebarTasks` の fragment を持ち、`useFragment` で描く。Shell は 2 つの query（`ShellProjectsQuery`、`ShellWorkspaceQuery`）を `useLazyLoadQuery`（store-or-network）で読み、project 未選択では `@include(if: $hasProject)` で会話・タスクを skip（DO RPC 0）。Suspense と ErrorBoundary を `QueryBoundary` に置き、0178 の `createRelaySource` と `fixtureSource` を削除した。web 38 tests / `npm run check` 通過。
