# 0049: agent の複数会話 API

status: open
priority: next
design: agreed
design-ref: D083
depends-on: 0034, 0046
touches: packages/agent/src, packages/agent/test, packages/server/src/do/session.ts, packages/server/src/do/session.test.ts

## Goal

server が会話の usage / inspect を扱えるように、agent の公開 API を広げる。server は pi-durable を直接 import しない。

## Acceptance criteria

- [ ] `AgentSession` に `usage()`（会話ごと / 合計のトークン・コスト）と `inspect()`（tasks / queued / scheduling）を足す
- [ ] usage / inspect の型は `@hns/agent/session`（実行中の状態。D030）
- [ ] server の `do/` から pi-durable の import を除去し、agent の薄いファクトリを使う
- [ ] 0146 の既存テスト（2 会話・再起動・alarm）がそのまま通る
- [ ] `npm run check`

## Notes

- 0146 の `openSession` が複数会話（create / list / get / send / transcript / abort）を提供済み（D083）。0049 は usage / inspect と server の依存除去に絞る。
- storage は呼び出し側（server）が注入する。

## Design（D083 で合意）

### 結論: 0146 で大半が済んでいる。usage / inspect と server の依存除去に絞る

根拠:

- 0146 の `openSession`（`@hns/agent/session`）が、複数会話の create / list / get / send / transcript / abort、ownerless、Worker-safe を提供している。
- server は `@hns/agent/session` を使うが、`packages/server/src/do/session.ts` は pi-durable の storage（`openDurableObjectSqliteStorage`）と `createRegistry` を直接 import している。
- 0049 の AC のうち「会話の作成・取得・ownerless」「送信・中断・transcript が会話単位」は 0146 の受入で満たされている。
- 残るのは `usage` と `inspect`（tasks / queued / scheduling）、および server の pi-durable 依存の除去。

### 決定案

- AC から 0146 が済ませた項目を落とす（二重に受入を持たない）。
- `AgentSession` に `usage()` と `inspect()` を足す。読み取り専用で、型付き。
  - `usage()`: 会話ごと / セッション合計のトークンとコスト（0146 の harness の usage を読む。実プロバイダの値は 0152）。
  - `inspect()`: tasks / queued / scheduling の snapshot。内部語（pi.*）は出さない。
- `do/session.ts` の pi-durable import を `@hns/agent/session` の薄いファクトリ（storage を開く・registry を作る）に移す。server は agent の subpath だけを使う。
- 0152 とは独立（faux の usage で契約をテストする。実値は 0152 が入れる）。

### 決定（D083）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | 範囲を usage / inspect と依存除去に絞るか | **決定（user）**: 絞る（0146 の二重受入を落とす） | 0146 / 0152 | 2026-11-17 |
| U-02 | usage / inspect の型の置き場 | **決定（user）**: `@hns/agent/session`（実行中の状態。core に載せない。D030） | D030 / 0152 | 2026-11-17 |
| U-03 | pi-durable import の除去を 0049 に含めるか | **決定（user）**: 含める（server の境界） | 0146 / 0049 | 2026-11-17 |

### テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 2 会話で turn を送る → usage() → 会話ごとと合計が返る | 高 | 受入1 |
| C2 | 空 / 実行中 → inspect() → tasks / queued / scheduling の形が閉じた union で返る | 高 | 受入1 |
| C3 | server の `do/` を grep / lint → pi-durable の import が無い | 中 | 受入3 |
| C4 | 0146 の既存テスト（2 会話・再起動・alarm）→ そのまま通る | 高 | 受入4 |
| C5 | `npm run check` | 高 | 受入5 |

層は unit（usage / inspect の形）と integration（実 SQLite で 2 会話）。実プロバイダの usage は 0152。
## やらないこと

- Model アダプタの追加。
- hooks / events の拡張（0162）。

## Log

- 2026-11-17: D083 で合意。0146 の二重受入を落とし、usage / inspect と server の pi-durable 除去に絞った。
