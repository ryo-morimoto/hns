# 0274n: workerd で `sql.batch` が返らない（起動時の同一呼び出しは返る）

status: open
priority: now
design: pending
design-ref: 0239 の作業中に lead が観測（2026-11-19）
depends-on: —
touches: packages/store/src/sql.ts, packages/store/src/migrate.ts, packages/store/src/repositories/

## Intent

**0239 が E2E を workerd の本物の dispatch で動かそうとしたところ、`ShellProjectsQuery` が 10 秒で 504 になった。**
切り分け: **D1 の `prepare` / `first` / `run` は 5ms で返るが、`db.batch(...)` がリクエスト内で返らない**（**起動時の同一呼び出しは返る**）。store の migration と `trailRepository.addChange` などが **`sql.batch`** を使っており、workerd 内でハングする。

**これは 0239 の範囲外**（`packages/store` を触らない約束）。ただし `db.batch` は **workerd の本番機能**で、**本番でも同じことが起きるなら重大**。

## 確かめること（この issue の前半）

- [ ] **workerd 上で `db.batch([...])` が返らない条件**を最小再現で特定する（**同じ isolate で 2 回目から**か、**特定の SQL**（`RETURNING *` / `INSERT ... SELECT`）か、**`storage.transaction` の中か**）。
- [ ] **本番（`cf dev` か `wrangler dev`）で `/graphql` の `ShellProjectsQuery` 相当が通るか**を実測。**cf dev の integration は通っている**（`faces-start` など）ので、**条件が限定されている**はず——**その条件を Result に書く**。
- [ ] **回避策**（`sql.batch` を「逐次 + 自前トランザクション」にする）を採るかの判断材料。

## Log

- 2026-11-19: 0239 の E2E を workerd で動かそうとして発見。**起動時の同一呼び出しは返る**ので、**最初の実行だけ通る**型の欠陥の可能性がある。
