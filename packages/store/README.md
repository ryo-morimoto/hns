# @hns/store

Cloudflare D1 の永続化。migration、リポジトリ、Row → 公開モデル（`@hns/core`）の変換を持つ。

- `src/sql.ts` — D1 binding の最小の型と、rows / changes を正規化する `createSql`。
- `src/db.ts` — 注入可能な clock / id と、リポジトリが共有する context。
- `src/migrate.ts` — schema と `schema_migrations` の migration。開くたびに冪等。
- `src/migrations/` — 1版1ファイル。表を足すときは `NNNN-name.ts` を足し、`index.ts` の `MIGRATIONS` に1行足す。
- `src/store.ts` — `openStore({ d1 })`。名前空間ごとに**今の面が使う側だけ**を公開する: projects / tasks は
  読み書き、conversations は `page` / `get` / `touch`（書き込みは Session の索引）、workflows / automations は
  読み取り（未使用の書き込み API は呼び出しが来る issue で足す）。観測は `obs_events`（Session DO）、ターンの
  費用は `cost_turn`（D1）が正本で、旧 `events` / `usage_log` は migration 6 で廃止した。
- `src/schemas.ts` / `src/parse.ts` — Row の valibot schema と公開型への `parse`。不正な Row は throw する。
- `src/journal/` — Workspace DO の Journal の行 schema・`parse`・本文の object key。表は DO が開くときに作り、D1 の migration ではない。
- `src/repositories/` — 各リポジトリ。書き込みは1文か D1 の batch、読み取りは `parse` を通す。

```ts
const store = await openStore({ d1: env.DB });
const project = await store.projects.ensureDefault();
const page = await store.conversations.page({ projectId: project.id, limit: 50 });
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
store は DB ドライバを持たない（`node:sqlite` は持たない、D064）。D1 は binding、Journal は Workspace DO の SQLite で、
ここは schema と `parse` だけを持つ。D1 のテストは workerd を起動するため integration 層に置く。
