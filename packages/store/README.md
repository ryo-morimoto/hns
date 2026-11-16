# @hns/store

Cloudflare D1 の永続化。migration、リポジトリ、Row → 公開モデル（`@hns/core`）の変換を持つ。

- `src/sql.ts` — D1 binding の最小の型と、rows / changes を正規化する `createSql`。
- `src/db.ts` — 注入可能な clock / id と、リポジトリが共有する context。
- `src/migrate.ts` — schema と `schema_migrations` の migration。開くたびに冪等。
- `src/migrations/` — 1版1ファイル。表を足すときは `NNNN-name.ts` を足し、`index.ts` の `MIGRATIONS` に1行足す。
- `src/store.ts` — `openStore({ d1 })`。projects / tasks / conversations / events / workflows / automations / usage を名前空間で公開する。
- `src/schemas.ts` / `src/parse.ts` — Row の valibot schema と公開型への `parse`。不正な Row は throw する。
- `src/repositories/` — 各リポジトリ。書き込みは1文か D1 の batch、読み取りは `parse` を通す。

```ts
const store = await openStore({ d1: env.DB });
const project = await store.projects.ensureDefault();
const workflow = await store.workflows.create({ projectId: project.id, name: "flow", graph });
const run = await store.workflows.createRun({ workflowId: workflow.id, input: "ship" });
await store.close();
```

```bash
npm test        # unit（parse / schema）+ integration（miniflare の実 D1 SQLite）
npm run typecheck
npm run build
```

identity（users / sessions / secrets）は `./identity` に分ける（0048）。

`openStore` は migration を適用してから default project を用意する。`schema_migrations` が自分より新しい版を
持つ DB は fail closed で開かない。`migrateStore(d1)` はリポジトリを開かずに migration だけを適用する。
store は D1 専用で、`node:sqlite` は持たない（D064）。テストは workerd を起動するため integration 層に置く。
