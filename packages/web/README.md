# @hns/web

## GraphQL の生成物

`npm run codegen` が `packages/web/schema.graphql`（`@hns/server/graphql` の `buildSchemaSdl()`）と
`packages/web/src/__generated__/`（relay-compiler の artifact）を書く。どちらも commit し、手で編集しない。
`__generated__` は oxfmt の対象外（codegen の出力をそのまま commit する）。

hns の React UI。読み取りは `WorkspaceSource`（モデルを返す口）を通し、response 型をここで手書きしない。
今は fixture 実装だけで、0178 が Relay に置き換える。

- `npm run dev -w @hns/web`: Vite。server はまだ無い（0145 が `/graphql` の口を作る）
- `npm run typecheck / build / test -w @hns/web`
