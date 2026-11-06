# @hns/store

SQLite の Row 型と、公開モデル（`@hns/core`）への変換。

- `src/rows.ts` — DB の形（`archived: 0 | 1`、JSON 文字列）。**パッケージの外に出さない。**
- `src/map.ts` — Row → 公開型。ID の brand と列挙の検証はここで行う。

```bash
npm test
npm run typecheck
npm run build
```
