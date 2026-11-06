# @hns/core

hns のドメイン型と API の契約。`src/types.ts` が型、`src/contracts.ts` が zod の正本。

```bash
npm test                # 実サーバを起動してレスポンスを検証する
npm run typecheck
npm run build           # dist/ に型と JS
```

- `src/types.ts` — ドメイン型（`z.infer`）。pi-ai の `types.ts` と同じ役割。
- `src/contracts.ts` — リクエスト・レスポンス・イベントの zod。
- `src/openapi.ts` — ルート表と OpenAPI 3.1。
- `test/contract.test.ts` — 実サーバとの一致を検証（モックにしない）。
