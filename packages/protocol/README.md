# @hns/protocol

API の契約（zod）。ここが正本で、型と OpenAPI はここから作る。

```bash
npm install
node --test test/*.test.ts   # 実サーバを起動してレスポンスを検証する
node node_modules/typescript/bin/tsc --noEmit
```

- `src/schemas.ts`: リクエスト・レスポンス・イベント。
- `src/openapi.ts`: ルート表と OpenAPI 3.1 の生成。
- `test/contract.test.ts`: 実サーバとの一致を検証（モックにしない）。
