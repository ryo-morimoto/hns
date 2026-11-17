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

## 配信

- `npm run build -w @hns/web` は `deploy/assets` に書く（source map なし）。cf は `tools/deploy` の
  `wrangler.config.ts` が指す `ASSETS` で配る。
- 開発は `npm run dev -w @hns/web`。Vite の `server.proxy` が `/graphql` / `/api` / `/ws` を
  `HNS_API`（既定 `http://127.0.0.1:8787`）へ same-origin で流す。
- `/graphql` が 401 のときは `auth/login.ts` が `/login?next=<deep link>` へ送る。ログイン画面は 0108 が持ち、
  `nextPathFrom` で元の deep link に戻す。
- `npm run typecheck / build / test -w @hns/web`、`npm run codegen`（リポジトリのルートで実行）。
