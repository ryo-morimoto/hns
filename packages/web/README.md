# @hns/web

## GraphQL の生成物

`npm run codegen` が `packages/web/schema.graphql`（`@hns/server/graphql` の `buildSchemaSdl()`）と
`packages/web/src/__generated__/`（relay-compiler の artifact）を書く。どちらも commit し、手で編集しない。
`__generated__` は oxfmt の対象外（codegen の出力をそのまま commit する）。

## 読み

読みは Relay が持つ。`Shell` が `ShellProjectsQuery` と `ShellWorkspaceQuery` を `useLazyLoadQuery`
（`store-or-network`）で読み、`Sidebar` は `SidebarProjects` / `SidebarConversations` / `SidebarTasks`
の fragment を `useFragment` で描く（選択は component が持つ）。project 未選択では会話・タスクの
field を `@include(if: $hasProject)` で skip し、Session RPC を出さない。

- `npm run dev -w @hns/web`: Vite。`/graphql` へは同じ origin で送る（配信は 0160）
- `npm run typecheck / build / test -w @hns/web`
- `npm run codegen`: schema と artifact の再生成（リポジトリのルートで実行）
