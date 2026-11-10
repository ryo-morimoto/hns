# @hns/web

hns の React UI。読み取りは `WorkspaceSource`（モデルを返す口）を通し、response 型をここで手書きしない。
今は fixture 実装だけで、0178 が Relay に置き換える。

- `npm run dev -w @hns/web`: Vite。server はまだ無い（0145 が `/graphql` の口を作る）
- `npm run typecheck / build / test -w @hns/web`
