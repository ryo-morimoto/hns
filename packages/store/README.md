# @hns/store

SQLite の Row を valibot で parse し、公開モデル（`@hns/core`）に変換する。

- `src/schemas.ts` — Row の schema。入力は DB の形（`archived: 0 | 1`・JSON 文字列）、出力は公開型。
- `src/parse.ts` — `parseProject` / `parseConversation` / `parseTask` / `parseEvent`。不正なら throw。

```bash
npm test        # 実 SQLite（:memory:）も含む
npm run typecheck
npm run build
```
