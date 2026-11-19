# 0274n: workerd で `sql.batch` が返らない（起動時の同一呼び出しは返る）

status: done
priority: now
design: agreed
design-ref: 0239 の作業中に lead が観測（2026-11-19）
depends-on: —
touches: packages/store/src/sql.ts, packages/store/src/migrate.ts, packages/store/src/repositories/

## Intent

**0239 が E2E を workerd の本物の dispatch で動かそうとしたところ、`ShellProjectsQuery` が 10 秒で 504 になった。**
切り分け: **D1 の `prepare` / `first` / `run` は 5ms で返るが、`db.batch(...)` がリクエスト内で返らない**（**起動時の同一呼び出しは返る**）。store の migration と `trailRepository.addChange` などが **`sql.batch`** を使っており、workerd 内でハングする。

**これは 0239 の範囲外**（`packages/store` を触らない約束）。ただし `db.batch` は **workerd の本番機能**で、**本番でも同じことが起きるなら重大**。

## 確かめること（この issue の前半）

- [x] **workerd 上で `db.batch([...])` が返らない条件**を最小再現で特定する（**同じ isolate で 2 回目から**か、**特定の SQL**（`RETURNING *` / `INSERT ... SELECT`）か、**`storage.transaction` の中か**）。
- [x] **本番（`cf dev` か `wrangler dev`）で `/graphql` の `ShellProjectsQuery` 相当が通るか**を実測。**cf dev の integration は通っている**（`faces-start` など）ので、**条件が限定されている**はず——**その条件を Result に書く**。
- [x] **回避策**（`sql.batch` を「逐次 + 自前トランザクション」にする）を採るかの判断材料。

## Log

- 2026-11-19: 0239 の E2E を workerd で動かそうとして発見。**起動時の同一呼び出しは返る**ので、**最初の実行だけ通る**型の欠陥の可能性がある。

## Result

- verdict: **PASS**（reviewer-0274n。blocking 0。**「結論は正しいが因果が読み」**という指摘を受け、因果を実測できる差分だけに直し、覆っていない条件を明示した）
- HEAD: 6ac0134（main に ff 統合）。gate は exit 0（**2034 tests / 2036**、worktree で 202.5s、main で 196.6s）。
- **結論: 本番の欠陥でも miniflare の欠陥でも store の欠陥でもない**。**0239 の e2e の手製 D1（`e2e/support/d1.ts` の `node:sqlite` 代役）が D1 と違う答え方をしていた**のが原因で、**store も workerd も cf dev も正常**。**`packages/store` は 1 行も変えていない**（`sql.ts` は TSDoc のみ）。
- **実測**: miniflare（workerd）の **Worker の中**で、`openStore` 15ms（**migration の batch 込み**）/ bind した `prepare` 1〜4ms / **3 文の `db.batch` 0〜1ms**。**cf dev** でも 3 文が 4〜17ms、**実際のデプロイ形で `/graphql` の `ShellProjectsQuery` が 200**（1 回目 150〜190ms、2 回目以降 4〜5ms）。
- **手製の代役が D1 と違う点（コードで確かめられるもの）**: ①`batch` が逐次 `run()` で **SELECT / DDL の行を返さない** ②**原子的でない**（途中で失敗しても戻らない）。**それ以外の差分は実測していない**（TSDoc に明記）。
- **テスト（8 本）**: `d1-batch.test.ts`（miniflare の D1、**Worker の中で**）— 3 文が返る / **`INSERT ... RETURNING *` + no-op UPDATE + SELECT** が `[[{id,v}], [], [{id,v}]]` / **途中で UNIQUE 失敗した batch が丸ごと戻る** / **DO の SQLite（`ctx.storage.sql`）でも同じ行**。`d1-client-batch.test.ts`（store）— **Node クライアントでも `addChange` と同じ 3 文（RETURNING 込み）**が返る。
- **覆っていない条件（正直に）**: **`blockConcurrencyWhile` の中**（0239 の実際の条件候補）/ **同じ isolate の 2 回目以降と並行 dispatch** / **cf dev の常設 integration**（**実測はしたが project が repo に無く、再現手順も無い** = 未記録）。
- **規約の追加**: `docs/procedures/testing.md` に「**Workerd の上で確かめること**」——**代役で見た hang を D1 の欠陥と読まない**。**Worker の中で確かめないと分からない前提**の扱いを書いた。
- **残件**: **cf dev 上で実 D1 の製品 Worker を回す常設の integration**。**cf が Vite 検出で `npx vite` に委譲し `--port` を拒否する**ため、`tools/deploy` の外に置く構成が要る（**`work/research/e2e-testing.md` §2.1 / §2.2 に実測あり**。`cost/harness.ts` が同じ構成で cf dev を回している）。
