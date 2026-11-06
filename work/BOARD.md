# Board

残作業の索引。1 issue = 1ファイル（`work/issues/`）。形式は [README.md](README.md)。

| # | 作業 | 状態 | 依存 |
| --- | --- | --- | --- |
| [0001](issues/0001-t02-remainder.md) | T-02 の残り（監査・Root差し替え・Worker越し） | open | — |
| [0002](issues/0002-mutation-crash.md) | T-03/T-04 Mutation の故障注入 | open | 0001 |
| [0003](issues/0003-walking-skeleton.md) | Workspace Walking Skeleton | open | 0002 |
| [0004](issues/0004-dev-env.md) | 開発環境の固定（node） | open | — |

## ユーザー判断待ち

| # | 論点 | 案 |
| --- | --- | --- |
| D-1 | D001（1.5.0固定・Workspace層） | **採用済み** |
| D-2 | 要件#2 の配置 | **A で開始**（D004、[分解](../docs/topology.md)） |
| D-3 | MVP 範囲 | **採用済み**（D003） |

## 調査・検証

- [research/pi-durable-1.5.0.md](research/pi-durable-1.5.0.md): API・適合・失更新・封じ込め
- [research/](research/): 提供資料の原文（agentics / agent engineering / 開発プロセス / 設計プレイブック / 要件状態 v0.3）
- [poc/](poc/): conformance / mutation-gap / root-containment / daemon-life

## 制約

- 危険な Tool は Worker 認可が完成するまで公開しない。
- 外部副作用の exactly-once を前提にしない。