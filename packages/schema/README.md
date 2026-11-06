# @hns/schema

API の契約（zod）。ここが正本で、型と OpenAPI はここから作る。

```bash
npm install
npm test                # 実サーバを起動してレスポンスを検証する
npm run typecheck
npm run build           # dist/ に型と JS
```

- `src/schemas.ts` — リクエスト・レスポンス・イベント。
- `src/openapi.ts` — ルート表と OpenAPI 3.1 の生成。
- `test/contract.test.ts` — 実サーバとの一致を検証（モックにしない）。
