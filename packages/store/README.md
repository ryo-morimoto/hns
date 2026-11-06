# @hns/store

SQLite の永続化。migration、リポジトリ、Row → 公開モデル（`@hns/core`）の変換を持つ。

- `src/db.ts` — 接続、transaction、注入可能な clock / id。
- `src/migrate.ts` — schema と `PRAGMA user_version` の migration。開くたびに冪等。
- `src/store.ts` — `openStore({ path })`。projects / tasks / conversations / events / workflows / automations / usage を名前空間で公開する。
- `src/schemas.ts` / `src/parse.ts` — Row の valibot schema と公開型への `parse`。不正な Row は throw する。
- `src/repositories/` — 各リポジトリ。書き込みは transaction、読み取りは `parse` を通す。

```ts
const store = openStore({ path: ":memory:" });
store.projects.ensureDefault();
const workflow = store.workflows.create({ projectId, name: "flow", graph });
const run = store.workflows.createRun({ workflowId: workflow.id, input: "ship" });
store.close();
```

```bash
npm test        # 実 SQLite（:memory: / temp file）
npm run typecheck
npm run build
```

identity（users / sessions / secrets）は `./identity` に分ける（0048）。

既存の PoC `control.sqlite`（`user_version` 4）は移行しない。新しい path を使う。
store は自分より新しい `user_version` を見つけたら fail closed で開かない。
