# @hns/web

hns の React UI。契約は @hns/core の ROUTES / parseResponse で、response 型をここで手書きしない。

- `npm run dev -w @hns/web`: Vite。`/api` は `HNS_API`（既定 http://127.0.0.1:8787）へ proxy
- `VITE_HNS_FIXTURES=1`: fixture client で描く（server 0035 は不要）
- `npm run typecheck / build / test -w @hns/web`
