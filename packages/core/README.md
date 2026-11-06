# @hns/core

hns のモデル。**`src/types.ts` が正本**で、`src/validation.ts` の zod は型に適合することをコンパイラが検査する。

```bash
npm test                # 実サーバを起動してレスポンスを検証する
npm run typecheck
npm run build           # dist/ に型と JS
```

- `src/types.ts` — モデル（正本）。pi-ai の `types.ts` と同じ役割。
- `src/validation.ts` — `z.ZodType<T>` で型に縛った zod。合わなければコンパイルエラー。
- `test/api.test.ts` — 実サーバのレスポンスを検証（モックにしない）。
